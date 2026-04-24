export const adTools = [
  {
    name: 'list_ads',
    description: 'Получить список объявлений — всех, по адсету или кампании',
    inputSchema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'ID адсета (опционально)' },
        campaign_id: { type: 'string', description: 'ID кампании (опционально)' },
        status_filter: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ALL'], default: 'ALL' },
      },
    },
  },
  {
    name: 'create_ad',
    description: 'Создать объявление с изображением или видео',
    inputSchema: {
      type: 'object',
      required: ['adset_id', 'name', 'creative'],
      properties: {
        adset_id: { type: 'string', description: 'ID адсета' },
        name: { type: 'string', description: 'Название объявления' },
        creative: {
          type: 'object',
          description: 'Параметры креатива',
          required: ['message', 'link'],
          properties: {
            message: { type: 'string', description: 'Текст поста/объявления' },
            link: { type: 'string', description: 'URL для перехода' },
            headline: { type: 'string', description: 'Заголовок (опционально)' },
            description: { type: 'string', description: 'Описание под заголовком' },
            call_to_action: {
              type: 'string',
              enum: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'SUBSCRIBE', 'BOOK_TRAVEL', 'DOWNLOAD', 'GET_QUOTE', 'NO_BUTTON'],
              description: 'Кнопка призыва к действию',
              default: 'LEARN_MORE',
            },
            image_hash: { type: 'string', description: 'Hash загруженного изображения (из upload_image)' },
            video_id: { type: 'string', description: 'ID загруженного видео (из upload_video)' },
            image_url: { type: 'string', description: 'Прямой URL изображения (альтернатива image_hash)' },
          },
        },
      },
    },
  },
  {
    name: 'toggle_ad',
    description: 'Включить или выключить объявление',
    inputSchema: {
      type: 'object',
      required: ['ad_id', 'status'],
      properties: {
        ad_id: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      },
    },
  },
  {
    name: 'duplicate_ad',
    description: 'Дублировать объявление (для тестирования разных вариантов)',
    inputSchema: {
      type: 'object',
      required: ['ad_id'],
      properties: {
        ad_id: { type: 'string', description: 'ID объявления для копирования' },
        new_name: { type: 'string', description: 'Название копии' },
        adset_id: { type: 'string', description: 'ID адсета для копии (если не указан — тот же)' },
      },
    },
  },
];

export async function handleAdTool(name, args, api) {
  const accountId = api.adAccountId;
  const pageId = api.pageId;

  if (name === 'list_ads') {
    const params = {
      fields: 'id,name,status,adset_id,campaign_id,creative{id,name,image_url,video_id,body},created_time',
      limit: 100,
    };
    if (args.status_filter && args.status_filter !== 'ALL') {
      params.effective_status = JSON.stringify([args.status_filter]);
    }
    let endpoint = `/${accountId}/ads`;
    if (args.adset_id) endpoint = `/${args.adset_id}/ads`;
    else if (args.campaign_id) endpoint = `/${args.campaign_id}/ads`;

    const data = await api.get(endpoint, params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  if (name === 'create_ad') {
    const { creative } = args;

    // Build link data
    const linkData = {
      message: creative.message,
      link: creative.link,
      call_to_action: {
        type: creative.call_to_action || 'LEARN_MORE',
        value: { link: creative.link },
      },
    };
    if (creative.headline) linkData.name = creative.headline;
    if (creative.description) linkData.description = creative.description;
    if (creative.image_hash) linkData.image_hash = creative.image_hash;
    if (creative.image_url) linkData.picture = creative.image_url;

    let adCreative;

    if (creative.video_id) {
      // Video ad
      const videoData = {
        video_id: creative.video_id,
        message: creative.message,
        call_to_action: {
          type: creative.call_to_action || 'LEARN_MORE',
          value: { link: creative.link },
        },
      };
      if (creative.headline) videoData.title = creative.headline;
      if (creative.description) videoData.description = creative.description;

      adCreative = await api.post(`/${accountId}/adcreatives`, {
        name: `Creative: ${args.name}`,
        object_story_spec: JSON.stringify({
          page_id: pageId,
          video_data: videoData,
        }),
      });
    } else {
      // Image/link ad
      adCreative = await api.post(`/${accountId}/adcreatives`, {
        name: `Creative: ${args.name}`,
        object_story_spec: JSON.stringify({
          page_id: pageId,
          link_data: linkData,
        }),
      });
    }

    const adData = await api.post(`/${accountId}/ads`, {
      name: args.name,
      adset_id: args.adset_id,
      creative: JSON.stringify({ creative_id: adCreative.id }),
      status: 'PAUSED',
    });

    return {
      content: [{
        type: 'text',
        text: `Объявление создано (PAUSED).\nCreative ID: ${adCreative.id}\nAd ID: ${adData.id}\n${JSON.stringify(adData, null, 2)}`,
      }],
    };
  }

  if (name === 'toggle_ad') {
    const data = await api.post(`/${args.ad_id}`, { status: args.status });
    return { content: [{ type: 'text', text: `Объявление ${args.ad_id} → ${args.status}\n${JSON.stringify(data, null, 2)}` }] };
  }

  if (name === 'duplicate_ad') {
    const current = await api.get(`/${args.ad_id}`, {
      fields: 'name,adset_id,creative{id}',
    });
    const adData = await api.post(`/${accountId}/ads`, {
      name: args.new_name || `${current.name} (копия)`,
      adset_id: args.adset_id || current.adset_id,
      creative: JSON.stringify({ creative_id: current.creative.id }),
      status: 'PAUSED',
    });
    return { content: [{ type: 'text', text: `Объявление дублировано. Новый ID: ${adData.id}\n${JSON.stringify(adData, null, 2)}` }] };
  }

  throw new Error(`Unknown ad tool: ${name}`);
}
