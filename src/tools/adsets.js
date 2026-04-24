export const adsetTools = [
  {
    name: 'list_adsets',
    description: 'Получить список адсетов (групп объявлений) — всех или для конкретной кампании',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'ID кампании (опционально — если не указан, вернёт все адсеты)' },
        status_filter: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ALL'], default: 'ALL' },
      },
    },
  },
  {
    name: 'create_adset',
    description: 'Создать группу объявлений (адсет) с таргетингом',
    inputSchema: {
      type: 'object',
      required: ['campaign_id', 'name', 'optimization_goal', 'billing_event', 'daily_budget'],
      properties: {
        campaign_id: { type: 'string', description: 'ID кампании' },
        name: { type: 'string', description: 'Название адсета' },
        daily_budget: { type: 'number', description: 'Дневной бюджет в рублях' },
        optimization_goal: {
          type: 'string',
          enum: ['REACH', 'IMPRESSIONS', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'LEAD_GENERATION', 'OFFSITE_CONVERSIONS', 'THRUPLAY', 'POST_ENGAGEMENT'],
          description: 'Цель оптимизации',
        },
        billing_event: {
          type: 'string',
          enum: ['IMPRESSIONS', 'LINK_CLICKS', 'THRUPLAY'],
          description: 'Событие списания',
          default: 'IMPRESSIONS',
        },
        targeting: {
          type: 'object',
          description: 'Объект таргетинга Meta Ads',
          properties: {
            age_min: { type: 'number', default: 18 },
            age_max: { type: 'number', default: 65 },
            genders: { type: 'array', items: { type: 'number' }, description: '1=мужчины, 2=женщины, [] = все' },
            geo_locations: {
              type: 'object',
              description: 'Геотаргетинг',
              properties: {
                countries: { type: 'array', items: { type: 'string' } },
                cities: { type: 'array', items: { type: 'object' } },
              },
            },
            interests: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
              description: 'Интересы аудитории',
            },
            device_platforms: {
              type: 'array',
              items: { type: 'string', enum: ['mobile', 'desktop'] },
            },
          },
        },
        placements: {
          type: 'object',
          description: 'Плейсменты (если не указаны — Advantage+ автоматически)',
          properties: {
            publisher_platforms: { type: 'array', items: { type: 'string' } },
            facebook_positions: { type: 'array', items: { type: 'string' } },
            instagram_positions: { type: 'array', items: { type: 'string' } },
          },
        },
        start_time: { type: 'string', description: 'Дата начала ISO 8601' },
        stop_time: { type: 'string', description: 'Дата окончания ISO 8601' },
      },
    },
  },
  {
    name: 'toggle_adset',
    description: 'Включить или выключить адсет',
    inputSchema: {
      type: 'object',
      required: ['adset_id', 'status'],
      properties: {
        adset_id: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      },
    },
  },
  {
    name: 'update_adset_budget',
    description: 'Изменить бюджет адсета',
    inputSchema: {
      type: 'object',
      required: ['adset_id', 'daily_budget'],
      properties: {
        adset_id: { type: 'string' },
        daily_budget: { type: 'number', description: 'Новый дневной бюджет в рублях' },
      },
    },
  },
  {
    name: 'duplicate_adset',
    description: 'Дублировать адсет для A/B тестирования',
    inputSchema: {
      type: 'object',
      required: ['adset_id'],
      properties: {
        adset_id: { type: 'string', description: 'ID адсета для дублирования' },
        new_name: { type: 'string', description: 'Название копии (опционально)' },
        campaign_id: { type: 'string', description: 'ID кампании для копии (если не указан — та же кампания)' },
      },
    },
  },
];

export async function handleAdsetTool(name, args, api) {
  const accountId = api.adAccountId;

  if (name === 'list_adsets') {
    const params = {
      fields: 'id,name,status,daily_budget,lifetime_budget,optimization_goal,targeting,campaign_id,start_time,stop_time',
      limit: 100,
    };
    if (args.status_filter && args.status_filter !== 'ALL') {
      params.effective_status = JSON.stringify([args.status_filter]);
    }
    const endpoint = args.campaign_id
      ? `/${args.campaign_id}/adsets`
      : `/${accountId}/adsets`;
    const data = await api.get(endpoint, params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  if (name === 'create_adset') {
    const params = {
      campaign_id: args.campaign_id,
      name: args.name,
      optimization_goal: args.optimization_goal,
      billing_event: args.billing_event || 'IMPRESSIONS',
      status: 'PAUSED',
      daily_budget: Math.round(args.daily_budget * 100),
    };

    const targeting = args.targeting || {};
    params.targeting = JSON.stringify({
      age_min: targeting.age_min || 18,
      age_max: targeting.age_max || 65,
      ...(targeting.genders?.length ? { genders: targeting.genders } : {}),
      geo_locations: targeting.geo_locations || { countries: ['RU'] },
      ...(targeting.interests?.length ? { flexible_spec: [{ interests: targeting.interests }] } : {}),
      ...(targeting.device_platforms?.length ? { device_platforms: targeting.device_platforms } : {}),
    });

    if (args.placements) {
      params.targeting = JSON.stringify({
        ...JSON.parse(params.targeting),
        publisher_platforms: args.placements.publisher_platforms,
        facebook_positions: args.placements.facebook_positions,
        instagram_positions: args.placements.instagram_positions,
      });
    }

    if (args.start_time) params.start_time = args.start_time;
    if (args.stop_time) params.stop_time = args.stop_time;

    const data = await api.post(`/${accountId}/adsets`, params);
    return { content: [{ type: 'text', text: `Адсет создан (PAUSED). ID: ${data.id}\n${JSON.stringify(data, null, 2)}` }] };
  }

  if (name === 'toggle_adset') {
    const data = await api.post(`/${args.adset_id}`, { status: args.status });
    return { content: [{ type: 'text', text: `Адсет ${args.adset_id} → ${args.status}\n${JSON.stringify(data, null, 2)}` }] };
  }

  if (name === 'update_adset_budget') {
    const data = await api.post(`/${args.adset_id}`, { daily_budget: Math.round(args.daily_budget * 100) });
    return { content: [{ type: 'text', text: `Бюджет адсета обновлён до ${args.daily_budget}.\n${JSON.stringify(data, null, 2)}` }] };
  }

  if (name === 'duplicate_adset') {
    const current = await api.get(`/${args.adset_id}`, {
      fields: 'name,campaign_id,optimization_goal,billing_event,daily_budget,targeting,status,start_time,stop_time',
    });
    const params = {
      campaign_id: args.campaign_id || current.campaign_id,
      name: args.new_name || `${current.name} (копия)`,
      optimization_goal: current.optimization_goal,
      billing_event: current.billing_event,
      daily_budget: current.daily_budget,
      targeting: JSON.stringify(current.targeting),
      status: 'PAUSED',
    };
    if (current.start_time) params.start_time = current.start_time;
    if (current.stop_time) params.stop_time = current.stop_time;

    const data = await api.post(`/${accountId}/adsets`, params);
    return { content: [{ type: 'text', text: `Адсет продублирован. Новый ID: ${data.id}\n${JSON.stringify(data, null, 2)}` }] };
  }

  throw new Error(`Unknown adset tool: ${name}`);
}
