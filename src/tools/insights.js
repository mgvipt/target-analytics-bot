export const insightTools = [
  {
    name: 'get_account_overview',
    description: 'Обзор рекламного аккаунта: общий расход, охват, клики, CPM за период',
    inputSchema: {
      type: 'object',
      properties: {
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month'],
          description: 'Временной период',
          default: 'last_7d',
        },
      },
    },
  },
  {
    name: 'get_campaign_insights',
    description: 'Детальная статистика по кампаниям: расход, CPM, CTR, CPC, конверсии, ROAS',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Список ID кампаний (если не указан — все кампании)',
        },
        date_preset: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month'],
          default: 'last_7d',
        },
        since: { type: 'string', description: 'Дата начала YYYY-MM-DD (альтернатива date_preset)' },
        until: { type: 'string', description: 'Дата окончания YYYY-MM-DD' },
        breakdown: {
          type: 'string',
          enum: ['none', 'age', 'gender', 'device_platform', 'placement'],
          description: 'Разбивка данных',
          default: 'none',
        },
      },
    },
  },
  {
    name: 'get_adset_insights',
    description: 'Статистика по группам объявлений',
    inputSchema: {
      type: 'object',
      properties: {
        adset_ids: { type: 'array', items: { type: 'string' }, description: 'ID адсетов (если пусто — все)' },
        campaign_id: { type: 'string', description: 'Фильтр по кампании' },
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month'], default: 'last_7d' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
    },
  },
  {
    name: 'get_ad_insights',
    description: 'Статистика по отдельным объявлениям для выявления лучших и худших',
    inputSchema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'Фильтр по адсету' },
        campaign_id: { type: 'string', description: 'Фильтр по кампании' },
        date_preset: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month'], default: 'last_7d' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
    },
  },
  {
    name: 'analyze_performance',
    description: 'Автоматический анализ эффективности: выявляет лучшие/худшие кампании и даёт рекомендации по оптимизации бюджета',
    inputSchema: {
      type: 'object',
      properties: {
        date_preset: { type: 'string', enum: ['last_7d', 'last_14d', 'last_30d'], default: 'last_7d' },
        optimization_goal: {
          type: 'string',
          enum: ['ROAS', 'CPA', 'CTR', 'CPM'],
          description: 'По какой метрике оптимизировать',
          default: 'ROAS',
        },
      },
    },
  },
];

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'clicks', 'reach',
  'cpm', 'cpc', 'ctr', 'cpp',
  'actions', 'action_values', 'cost_per_action_type',
  'frequency', 'date_start', 'date_stop',
].join(',');

function buildTimeParams(args) {
  if (args.since && args.until) {
    return { time_range: JSON.stringify({ since: args.since, until: args.until }) };
  }
  return { date_preset: args.date_preset || 'last_7d' };
}

function parseActions(actions = []) {
  const result = {};
  for (const a of actions) {
    result[a.action_type] = parseFloat(a.value) || 0;
  }
  return result;
}

function formatInsightRow(row) {
  const actions = parseActions(row.actions);
  const actionValues = parseActions(row.action_values);
  const spend = parseFloat(row.spend || 0);
  const purchases = actions['purchase'] || actions['offsite_conversion.fb_pixel_purchase'] || 0;
  const purchaseValue = actionValues['purchase'] || actionValues['offsite_conversion.fb_pixel_purchase'] || 0;
  const leads = actions['lead'] || actions['offsite_conversion.fb_pixel_lead'] || 0;
  const roas = spend > 0 && purchaseValue > 0 ? (purchaseValue / spend).toFixed(2) : null;
  const cpa = purchases > 0 ? (spend / purchases).toFixed(2) : leads > 0 ? (spend / leads).toFixed(2) : null;

  return {
    id: row.campaign_id || row.adset_id || row.ad_id,
    name: row.campaign_name || row.adset_name || row.ad_name,
    spend: spend.toFixed(2),
    impressions: parseInt(row.impressions || 0),
    clicks: parseInt(row.clicks || 0),
    reach: parseInt(row.reach || 0),
    cpm: parseFloat(row.cpm || 0).toFixed(2),
    cpc: parseFloat(row.cpc || 0).toFixed(2),
    ctr: parseFloat(row.ctr || 0).toFixed(2) + '%',
    frequency: parseFloat(row.frequency || 0).toFixed(2),
    purchases: purchases || undefined,
    leads: leads || undefined,
    roas: roas ? `${roas}x` : undefined,
    cpa: cpa || undefined,
    period: `${row.date_start} — ${row.date_stop}`,
  };
}

export async function handleInsightTool(name, args, api) {
  const accountId = api.adAccountId;

  if (name === 'get_account_overview') {
    const data = await api.get(`/${accountId}/insights`, {
      fields: 'spend,impressions,clicks,reach,cpm,ctr,cpc,actions,action_values,frequency',
      ...buildTimeParams(args),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  if (name === 'get_campaign_insights') {
    const params = {
      fields: INSIGHT_FIELDS,
      level: 'campaign',
      limit: 100,
      ...buildTimeParams(args),
    };
    if (args.breakdown && args.breakdown !== 'none') {
      params.breakdowns = args.breakdown;
    }
    if (args.campaign_ids?.length) {
      params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: args.campaign_ids }]);
    }
    const data = await api.get(`/${accountId}/insights`, params);
    const formatted = (data.data || []).map(formatInsightRow);
    return { content: [{ type: 'text', text: JSON.stringify({ summary: formatted, raw: data }, null, 2) }] };
  }

  if (name === 'get_adset_insights') {
    const params = {
      fields: INSIGHT_FIELDS,
      level: 'adset',
      limit: 200,
      ...buildTimeParams(args),
    };
    if (args.campaign_id) {
      params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [args.campaign_id] }]);
    }
    if (args.adset_ids?.length) {
      params.filtering = JSON.stringify([{ field: 'adset.id', operator: 'IN', value: args.adset_ids }]);
    }
    const data = await api.get(`/${accountId}/insights`, params);
    const formatted = (data.data || []).map(formatInsightRow);
    return { content: [{ type: 'text', text: JSON.stringify({ summary: formatted, raw: data }, null, 2) }] };
  }

  if (name === 'get_ad_insights') {
    const params = {
      fields: INSIGHT_FIELDS,
      level: 'ad',
      limit: 200,
      ...buildTimeParams(args),
    };
    if (args.campaign_id) {
      params.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [args.campaign_id] }]);
    }
    if (args.adset_id) {
      params.filtering = JSON.stringify([{ field: 'adset.id', operator: 'IN', value: [args.adset_id] }]);
    }
    const data = await api.get(`/${accountId}/insights`, params);
    const formatted = (data.data || []).map(formatInsightRow);
    return { content: [{ type: 'text', text: JSON.stringify({ summary: formatted, raw: data }, null, 2) }] };
  }

  if (name === 'analyze_performance') {
    // Fetch campaigns + their insights
    const [campaigns, insightsData] = await Promise.all([
      api.get(`/${accountId}/campaigns`, {
        fields: 'id,name,status,daily_budget,objective',
        limit: 100,
      }),
      api.get(`/${accountId}/insights`, {
        fields: INSIGHT_FIELDS,
        level: 'campaign',
        limit: 100,
        ...buildTimeParams(args),
      }),
    ]);

    const insightMap = {};
    for (const row of insightsData.data || []) {
      insightMap[row.campaign_id] = formatInsightRow(row);
    }

    const goal = args.optimization_goal || 'ROAS';
    const result = {
      goal,
      period: args.date_preset || 'last_7d',
      campaigns: [],
      recommendations: [],
    };

    for (const c of campaigns.data || []) {
      const stats = insightMap[c.id] || {};
      result.campaigns.push({
        id: c.id,
        name: c.name,
        status: c.status,
        daily_budget: c.daily_budget ? (parseInt(c.daily_budget) / 100).toFixed(0) : null,
        ...stats,
      });
    }

    // Generate recommendations
    const withSpend = result.campaigns.filter(c => parseFloat(c.spend || 0) > 0);
    const sorted = [...withSpend].sort((a, b) => {
      if (goal === 'ROAS') return parseFloat(b.roas || 0) - parseFloat(a.roas || 0);
      if (goal === 'CTR') return parseFloat(b.ctr || 0) - parseFloat(a.ctr || 0);
      if (goal === 'CPM') return parseFloat(a.cpm || 0) - parseFloat(b.cpm || 0);
      return parseFloat(a.cpa || 999) - parseFloat(b.cpa || 999);
    });

    if (sorted.length > 0) {
      const top = sorted.slice(0, Math.ceil(sorted.length * 0.3));
      const bottom = sorted.slice(Math.floor(sorted.length * 0.7));
      for (const c of top) {
        result.recommendations.push(`МАСШТАБИРОВАТЬ: "${c.name}" — ${goal}: ${c[goal.toLowerCase()] || c.roas || c.ctr}, spend: ${c.spend}`);
      }
      for (const c of bottom) {
        result.recommendations.push(`ПРОВЕРИТЬ/ОТКЛЮЧИТЬ: "${c.name}" — ${goal}: ${c[goal.toLowerCase()] || c.roas || c.ctr}, spend: ${c.spend}`);
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  throw new Error(`Unknown insight tool: ${name}`);
}
