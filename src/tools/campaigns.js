export const campaignTools = [
  {
    name: 'list_campaigns',
    description: 'Получить список всех кампаний с их статусом, бюджетом и основными метриками',
    inputSchema: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          enum: ['ACTIVE', 'PAUSED', 'ALL'],
          description: 'Фильтр по статусу кампаний',
          default: 'ALL',
        },
      },
    },
  },
  {
    name: 'create_campaign',
    description: 'Создать новую рекламную кампанию в Meta Ads',
    inputSchema: {
      type: 'object',
      required: ['name', 'objective', 'daily_budget'],
      properties: {
        name: { type: 'string', description: 'Название кампании' },
        objective: {
          type: 'string',
          enum: [
            'OUTCOME_AWARENESS',
            'OUTCOME_TRAFFIC',
            'OUTCOME_ENGAGEMENT',
            'OUTCOME_LEADS',
            'OUTCOME_APP_PROMOTION',
            'OUTCOME_SALES',
          ],
          description: 'Цель кампании',
        },
        daily_budget: { type: 'number', description: 'Дневной бюджет в рублях (или валюте аккаунта)' },
        bid_strategy: {
          type: 'string',
          enum: ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP'],
          description: 'Стратегия ставок',
          default: 'LOWEST_COST_WITHOUT_CAP',
        },
        start_time: { type: 'string', description: 'Дата начала в формате ISO 8601 (опционально)' },
        stop_time: { type: 'string', description: 'Дата окончания в формате ISO 8601 (опционально)' },
      },
    },
  },
  {
    name: 'update_campaign_budget',
    description: 'Изменить дневной или общий бюджет кампании',
    inputSchema: {
      type: 'object',
      required: ['campaign_id', 'daily_budget'],
      properties: {
        campaign_id: { type: 'string', description: 'ID кампании' },
        daily_budget: { type: 'number', description: 'Новый дневной бюджет в рублях' },
      },
    },
  },
  {
    name: 'toggle_campaign',
    description: 'Включить или выключить кампанию',
    inputSchema: {
      type: 'object',
      required: ['campaign_id', 'status'],
      properties: {
        campaign_id: { type: 'string', description: 'ID кампании' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'], description: 'Новый статус' },
      },
    },
  },
  {
    name: 'scale_campaign',
    description: 'Масштабировать кампанию — увеличить бюджет на заданный процент',
    inputSchema: {
      type: 'object',
      required: ['campaign_id', 'scale_percent'],
      properties: {
        campaign_id: { type: 'string', description: 'ID кампании' },
        scale_percent: { type: 'number', description: 'На сколько процентов увеличить бюджет (например, 30 = +30%)' },
      },
    },
  },
  {
    name: 'delete_campaign',
    description: 'Удалить кампанию (необратимо)',
    inputSchema: {
      type: 'object',
      required: ['campaign_id'],
      properties: {
        campaign_id: { type: 'string', description: 'ID кампании' },
      },
    },
  },
];

export async function handleCampaignTool(name, args, api) {
  const accountId = api.adAccountId;

  if (name === 'list_campaigns') {
    const statusFilter = args.status_filter || 'ALL';
    const params = {
      fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time',
      limit: 100,
    };
    if (statusFilter !== 'ALL') {
      params.effective_status = JSON.stringify([statusFilter]);
    }
    const data = await api.get(`/${accountId}/campaigns`, params);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === 'create_campaign') {
    const params = {
      name: args.name,
      objective: args.objective,
      status: 'PAUSED',
      special_ad_categories: '[]',
      bid_strategy: args.bid_strategy || 'LOWEST_COST_WITHOUT_CAP',
    };
    if (args.daily_budget) params.daily_budget = Math.round(args.daily_budget * 100);
    if (args.start_time) params.start_time = args.start_time;
    if (args.stop_time) params.stop_time = args.stop_time;

    const data = await api.post(`/${accountId}/campaigns`, params);
    return {
      content: [{ type: 'text', text: `Кампания создана (статус: PAUSED). ID: ${data.id}\n${JSON.stringify(data, null, 2)}` }],
    };
  }

  if (name === 'update_campaign_budget') {
    const data = await api.post(`/${args.campaign_id}`, {
      daily_budget: Math.round(args.daily_budget * 100),
    });
    return {
      content: [{ type: 'text', text: `Бюджет кампании ${args.campaign_id} обновлён до ${args.daily_budget}.\n${JSON.stringify(data, null, 2)}` }],
    };
  }

  if (name === 'toggle_campaign') {
    const data = await api.post(`/${args.campaign_id}`, { status: args.status });
    return {
      content: [{ type: 'text', text: `Кампания ${args.campaign_id} переведена в статус ${args.status}.\n${JSON.stringify(data, null, 2)}` }],
    };
  }

  if (name === 'scale_campaign') {
    const current = await api.get(`/${args.campaign_id}`, { fields: 'daily_budget,name' });
    const currentBudget = parseInt(current.daily_budget || 0);
    const newBudget = Math.round(currentBudget * (1 + args.scale_percent / 100));
    const data = await api.post(`/${args.campaign_id}`, { daily_budget: newBudget });
    const oldFormatted = (currentBudget / 100).toFixed(0);
    const newFormatted = (newBudget / 100).toFixed(0);
    return {
      content: [{
        type: 'text',
        text: `Кампания "${current.name}" масштабирована +${args.scale_percent}%: ${oldFormatted} → ${newFormatted} (валюта аккаунта).\n${JSON.stringify(data, null, 2)}`,
      }],
    };
  }

  if (name === 'delete_campaign') {
    const data = await api.del(`/${args.campaign_id}`);
    return {
      content: [{ type: 'text', text: `Кампания ${args.campaign_id} удалена.\n${JSON.stringify(data, null, 2)}` }],
    };
  }

  throw new Error(`Unknown campaign tool: ${name}`);
}
