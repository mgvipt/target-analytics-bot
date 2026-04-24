import { createReadStream, statSync } from 'fs';
import FormData from 'form-data';

export const contentTools = [
  {
    name: 'upload_image',
    description: 'Загрузить изображение в рекламный аккаунт Meta для использования в объявлениях',
    inputSchema: {
      type: 'object',
      required: ['image_path'],
      properties: {
        image_path: { type: 'string', description: 'Абсолютный путь к файлу изображения на диске' },
      },
    },
  },
  {
    name: 'upload_video',
    description: 'Загрузить видео в рекламный аккаунт Meta для использования в объявлениях или Reels',
    inputSchema: {
      type: 'object',
      required: ['video_path'],
      properties: {
        video_path: { type: 'string', description: 'Абсолютный путь к видеофайлу' },
        title: { type: 'string', description: 'Название видео' },
        description: { type: 'string', description: 'Описание видео' },
      },
    },
  },
  {
    name: 'create_facebook_post',
    description: 'Опубликовать пост на Facebook Странице',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Текст поста' },
        link: { type: 'string', description: 'URL ссылки (опционально)' },
        image_path: { type: 'string', description: 'Путь к изображению (опционально)' },
        published: { type: 'boolean', description: 'Опубликовать сразу (true) или как черновик (false)', default: true },
        scheduled_publish_time: { type: 'number', description: 'Unix timestamp для отложенной публикации' },
      },
    },
  },
  {
    name: 'create_instagram_post',
    description: 'Опубликовать фото или карусель в Instagram',
    inputSchema: {
      type: 'object',
      required: ['image_url', 'caption'],
      properties: {
        image_url: { type: 'string', description: 'Публичный URL изображения' },
        caption: { type: 'string', description: 'Подпись к посту' },
        location_id: { type: 'string', description: 'ID геолокации (опционально)' },
      },
    },
  },
  {
    name: 'create_instagram_reel',
    description: 'Опубликовать Reel в Instagram (двухэтапный процесс: загрузка + публикация)',
    inputSchema: {
      type: 'object',
      required: ['video_url', 'caption'],
      properties: {
        video_url: { type: 'string', description: 'Публичный URL видео (mp4, макс. 60 сек для Reels или 15 мин для видео)' },
        caption: { type: 'string', description: 'Подпись к Reels' },
        cover_url: { type: 'string', description: 'URL обложки Reel (опционально)' },
        share_to_feed: { type: 'boolean', description: 'Показывать в ленте (default: true)', default: true },
      },
    },
  },
  {
    name: 'get_instagram_media',
    description: 'Получить список опубликованных медиа в Instagram (посты, Reels)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Количество последних публикаций', default: 20 },
        media_type: { type: 'string', enum: ['IMAGE', 'VIDEO', 'REEL', 'CAROUSEL_ALBUM', 'ALL'], default: 'ALL' },
      },
    },
  },
  {
    name: 'get_page_posts',
    description: 'Получить список постов на Facebook Странице',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
      },
    },
  },
];

export async function handleContentTool(name, args, api) {
  const accountId = api.adAccountId;
  const pageId = api.pageId;
  const igAccountId = api.igAccountId;

  if (name === 'upload_image') {
    const form = new FormData();
    form.append('filename', createReadStream(args.image_path));
    form.append('access_token', api.accessToken);

    const data = await api.postForm(`/${accountId}/adimages`, form);
    const images = data.images || {};
    const keys = Object.keys(images);
    if (keys.length === 0) throw new Error('Image upload failed: ' + JSON.stringify(data));
    const uploaded = images[keys[0]];
    return {
      content: [{
        type: 'text',
        text: `Изображение загружено.\nHash: ${uploaded.hash}\nURL: ${uploaded.url}\n${JSON.stringify(uploaded, null, 2)}`,
      }],
    };
  }

  if (name === 'upload_video') {
    const form = new FormData();
    form.append('source', createReadStream(args.video_path));
    if (args.title) form.append('title', args.title);
    if (args.description) form.append('description', args.description);
    form.append('access_token', api.accessToken);

    const data = await api.postForm(`/${accountId}/advideos`, form);
    return {
      content: [{
        type: 'text',
        text: `Видео загружено.\nVideo ID: ${data.id}\n${JSON.stringify(data, null, 2)}`,
      }],
    };
  }

  if (name === 'create_facebook_post') {
    const params = {
      message: args.message,
      published: args.published !== false,
    };
    if (args.link) params.link = args.link;
    if (args.scheduled_publish_time) {
      params.published = false;
      params.scheduled_publish_time = args.scheduled_publish_time;
    }

    let endpoint = `/${pageId}/feed`;

    if (args.image_path) {
      // Post with photo
      const form = new FormData();
      form.append('source', createReadStream(args.image_path));
      form.append('caption', args.message);
      form.append('published', String(params.published));
      form.append('access_token', api.accessToken);
      const data = await api.postForm(`/${pageId}/photos`, form);
      return { content: [{ type: 'text', text: `Пост с фото опубликован. ID: ${data.id || data.post_id}\n${JSON.stringify(data, null, 2)}` }] };
    }

    const data = await api.post(endpoint, params);
    return { content: [{ type: 'text', text: `Пост опубликован. ID: ${data.id}\n${JSON.stringify(data, null, 2)}` }] };
  }

  if (name === 'create_instagram_post') {
    // Step 1: create media container
    const container = await api.post(`/${igAccountId}/media`, {
      image_url: args.image_url,
      caption: args.caption,
      ...(args.location_id ? { location_id: args.location_id } : {}),
    });

    // Step 2: publish
    const published = await api.post(`/${igAccountId}/media_publish`, {
      creation_id: container.id,
    });

    return {
      content: [{
        type: 'text',
        text: `Instagram пост опубликован.\nMedia ID: ${published.id}\nContainer ID: ${container.id}`,
      }],
    };
  }

  if (name === 'create_instagram_reel') {
    // Step 1: create container
    const container = await api.post(`/${igAccountId}/media`, {
      media_type: 'REELS',
      video_url: args.video_url,
      caption: args.caption,
      share_to_feed: args.share_to_feed !== false,
      ...(args.cover_url ? { cover_url: args.cover_url } : {}),
    });

    // Step 2: poll status until ready
    let status = 'IN_PROGRESS';
    let attempts = 0;
    while (status === 'IN_PROGRESS' && attempts < 30) {
      await new Promise(r => setTimeout(r, 5000));
      const statusData = await api.get(`/${container.id}`, { fields: 'status_code,status' });
      status = statusData.status_code || statusData.status || 'ERROR';
      attempts++;
    }

    if (status !== 'FINISHED' && status !== 'READY') {
      throw new Error(`Reel processing failed with status: ${status}. Try again or check video URL.`);
    }

    // Step 3: publish
    const published = await api.post(`/${igAccountId}/media_publish`, {
      creation_id: container.id,
    });

    return {
      content: [{
        type: 'text',
        text: `Reel опубликован в Instagram!\nMedia ID: ${published.id}\nContainer ID: ${container.id}`,
      }],
    };
  }

  if (name === 'get_instagram_media') {
    const params = {
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit: args.limit || 20,
    };
    const data = await api.get(`/${igAccountId}/media`, params);
    let items = data.data || [];
    if (args.media_type && args.media_type !== 'ALL') {
      items = items.filter(m => m.media_type === args.media_type);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ count: items.length, media: items }, null, 2) }] };
  }

  if (name === 'get_page_posts') {
    const data = await api.get(`/${pageId}/posts`, {
      fields: 'id,message,story,full_picture,permalink_url,created_time,likes.summary(true),comments.summary(true)',
      limit: args.limit || 20,
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  throw new Error(`Unknown content tool: ${name}`);
}
