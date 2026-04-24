/**
 * generate-reports.js
 * Generates TWO Word documents:
 *   1. analytics.docx  — raw data tables (spend, CTR, CPM, etc.)
 *   2. recommendations.docx — detailed analysis + actionable recommendations
 * Both can be uploaded to Google Drive.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  ShadingType, BorderStyle, ImageRun,
} from 'docx';
import { writeFileSync, unlinkSync } from 'fs';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const value = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const IG_ID      = process.env.META_IG_ACCOUNT_ID;
const BASE_URL   = `https://graph.facebook.com/${process.env.META_API_VERSION || 'v21.0'}`;
const SHEET_URL  = 'https://docs.google.com/spreadsheets/d/1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';

const THRESHOLDS = { CTR_LOW: 1.0, CTR_WARN: 2.0, FREQ_WARN: 2.0, FREQ_HIGH: 3.0, LEARNING_DAYS: 7 };

// ── Meta API ────────────────────────────────────────────────────
async function metaGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  return res.json();
}

// ── Formatters ──────────────────────────────────────────────────
function fmt(n, d = 2) { return parseFloat(n || 0).toFixed(d); }
function fmtMoney(n)   { return `$${fmt(n)}`; }
function isLearning(startTime) {
  if (!startTime) return false;
  return (Date.now() - new Date(startTime)) / 86400000 < THRESHOLDS.LEARNING_DAYS;
}
function parseActions(actions) {
  const map = {};
  for (const a of actions || []) map[a.action_type] = parseFloat(a.value) || 0;
  return map;
}

// ── Chart generation ─────────────────────────────────────────────
async function makeChart(type, labels, datasets, options = {}) {
  const canvas = new ChartJSNodeCanvas({ width: 580, height: 300, backgroundColour: 'white' });
  return canvas.renderToBuffer({
    type,
    data: { labels, datasets },
    options: {
      ...options,
      plugins: {
        legend: { display: false },
        ...(options.plugins || {}),
      },
    },
  });
}

async function makeSpendChart(campaigns, insightMap) {
  const withData = campaigns.filter(c => insightMap[c.id] && parseFloat(insightMap[c.id].spend || 0) > 0);
  if (withData.length === 0) return null;
  const labels = withData.map(c => c.name.slice(0, 25));
  const data   = withData.map(c => parseFloat(insightMap[c.id].spend || 0));
  return makeChart('bar', labels, [{
    data,
    backgroundColor: 'rgba(41, 128, 185, 0.8)',
    borderColor: 'rgba(41, 128, 185, 1)',
    borderWidth: 1,
  }], {
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'USD' } },
      x: { ticks: { maxRotation: 30 } },
    },
  });
}

async function makeCtrChart(campaigns, insightMap) {
  const withData = campaigns.filter(c => insightMap[c.id] && parseFloat(insightMap[c.id].ctr || 0) > 0);
  if (withData.length === 0) return null;
  const labels = withData.map(c => c.name.slice(0, 25));
  const ctrs   = withData.map(c => parseFloat(insightMap[c.id].ctr || 0));
  const colors = ctrs.map(ctr =>
    ctr >= THRESHOLDS.CTR_WARN
      ? 'rgba(39, 174, 96, 0.8)'
      : ctr >= THRESHOLDS.CTR_LOW
        ? 'rgba(230, 126, 34, 0.8)'
        : 'rgba(192, 57, 43, 0.8)'
  );
  return makeChart('bar', labels, [{
    data: ctrs,
    backgroundColor: colors,
    borderColor: colors.map(c => c.replace('0.8', '1')),
    borderWidth: 1,
  }], {
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'CTR %' } },
      x: { ticks: { maxRotation: 30 } },
    },
  });
}

async function makeTopAdsCtrChart(adsWithData) {
  const top = adsWithData.slice(0, 10);
  if (top.length === 0) return null;
  const labels = top.map(a => a.ad_name.slice(0, 20));
  const ctrs   = top.map(a => parseFloat(a.ctr || 0));
  return makeChart('bar', labels, [{
    data: ctrs,
    backgroundColor: 'rgba(41, 128, 185, 0.75)',
    borderColor: 'rgba(41, 128, 185, 1)',
    borderWidth: 1,
  }], {
    indexAxis: 'y',
    scales: {
      x: { beginAtZero: true, title: { display: true, text: 'CTR %' } },
    },
  });
}

async function makeDailySpendChart(dailyData) {
  if (!dailyData || dailyData.length === 0) return null;
  const sorted = [...dailyData].sort((a, b) => a.date_start.localeCompare(b.date_start));
  const labels = sorted.map(d => d.date_start.slice(5));
  const data   = sorted.map(d => parseFloat(d.spend || 0));
  return makeChart('line', labels, [{
    data,
    borderColor: 'rgba(41, 128, 185, 1)',
    backgroundColor: 'rgba(41, 128, 185, 0.15)',
    tension: 0.3,
    fill: true,
    pointRadius: 3,
  }], {
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'USD' } },
    },
  });
}

function chartImage(buffer) {
  if (!buffer) return null;
  return new Paragraph({
    children: [new ImageRun({ data: buffer, transformation: { width: 510, height: 260 }, type: 'png' })],
    spacing: { before: 120, after: 120 },
  });
}

// ── Docx helpers ────────────────────────────────────────────────
const DARK    = '1A252F';
const ACCENT  = '2980B9';
const RED     = 'C0392B';
const GREEN   = '27AE60';
const ORANGE  = 'E67E22';
const YELLOW_BG = 'FEF9E7';
const RED_BG    = 'FDEDEC';
const GREEN_BG  = 'EAFAF1';

function h1(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 32, color: DARK })],
    spacing: { before: 400, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 } },
  });
}
function h2(text, color = DARK) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 26, color })],
    spacing: { before: 320, after: 100 },
  });
}
function h3(text, color = DARK) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 24, color })],
    spacing: { before: 240, after: 80 },
  });
}
function p(text, { bold = false, color, italic = false, size = 22 } = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold, color, italics: italic, size })],
    spacing: { after: 60 },
  });
}
function divider() {
  return new Paragraph({ spacing: { before: 120, after: 120 } });
}

// colWidths: array of DXA values per column (1 DXA = 1/20 pt, A4 content ≈ 8400 DXA)
function makeTable(headers, rows, { stripeColor = 'F8F9FA', colWidths } = {}) {
  const borderProps = { style: BorderStyle.SINGLE, size: 4, color: 'D5D8DC' };
  const totalWidth = 8400;
  const n = headers.length;
  const widths = colWidths || Array(n).fill(Math.floor(totalWidth / n));

  const makeCell = (text, bg, color, bold, wi) => new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), size: 20, color, bold: bold ?? false })],
    })],
    shading: { type: ShadingType.SOLID, color: bg, fill: bg },
    borders: { top: borderProps, bottom: borderProps, left: borderProps, right: borderProps },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    width: { size: widths[wi], type: WidthType.DXA },
  });

  const headerCells = headers.map((h, i) => new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: h, bold: true, size: 20, color: 'FFFFFF' })],
      alignment: AlignmentType.CENTER,
    })],
    shading: { type: ShadingType.SOLID, color: DARK, fill: DARK },
    borders: { top: borderProps, bottom: borderProps, left: borderProps, right: borderProps },
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    width: { size: widths[i], type: WidthType.DXA },
  }));

  const dataRows = rows.map((row, ri) => new TableRow({
    children: row.map((cell, ci) => {
      const isObj = typeof cell === 'object' && cell !== null;
      return makeCell(
        isObj ? cell.text : cell,
        isObj && cell.bg ? cell.bg : (ri % 2 === 1 ? stripeColor : 'FFFFFF'),
        isObj ? cell.color : undefined,
        isObj ? cell.bold : false,
        ci,
      );
    }),
  }));

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    rows: [new TableRow({ children: headerCells, tableHeader: true }), ...dataRows],
    columnWidths: widths,
  });
}

function titlePage(title, subtitle, period) {
  const items = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 52, color: DARK })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 600, after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: subtitle, size: 24, color: '7F8C8D' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
  ];
  if (period) {
    items.push(new Paragraph({
      children: [new TextRun({ text: `Период: ${period}`, size: 22, color: '95A5A6', italics: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
    }));
  }
  items.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 0 } },
    spacing: { after: 400 },
  }));
  return items;
}

function footer(dateStr) {
  return [
    divider(),
    new Paragraph({
      children: [new TextRun({ text: `📋 Таблица аналитики: ${SHEET_URL}`, size: 18, color: ACCENT })],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `Сгенерировано: ${dateStr} | @targetanalitik_bot`, size: 18, color: 'AAAAAA', italics: true })],
    }),
  ];
}

// ── Fetch all needed data ───────────────────────────────────────
// Supported datePreset values:
//   Native Meta presets: last_7d, last_14d, last_30d, this_week, last_week, last_month, last_90d
//   Custom periods:      last_6m  (180 days, uses time_range)
export async function fetchAllData(datePreset = 'last_7d') {
  const insightFields = 'spend,impressions,clicks,reach,cpm,ctr,cpc,actions,frequency';
  const campaignInsightFields = 'campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,actions,frequency,reach';
  const adsetInsightFields = 'adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,actions,frequency,reach';
  const adInsightFields = 'ad_id,ad_name,campaign_name,adset_name,spend,impressions,clicks,cpm,ctr,cpc,frequency,actions';

  // Native Meta date_preset values (everything else uses time_range)
  const NATIVE_PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_week', 'last_week', 'last_month']);
  const CUSTOM_FIXED_DAYS = { last_6m: 180 };

  // Resolve how many days for a custom period
  function resolveCustomDays() {
    if (CUSTOM_FIXED_DAYS[datePreset]) return CUSTOM_FIXED_DAYS[datePreset];
    const m = datePreset.match(/^last_(\d+)d$/);
    return m ? parseInt(m[1]) : 30;
  }

  const isCustom = !NATIVE_PRESETS.has(datePreset);
  const customDays = isCustom ? resolveCustomDays() : null;

  // For short periods use daily breakdown; for long periods use weekly (less data, faster)
  const SHORT_PRESETS = ['last_7d', 'last_14d', 'last_30d', 'this_week', 'last_week', 'last_month'];
  const timeIncrement = (SHORT_PRESETS.includes(datePreset) || (isCustom && customDays <= 30)) ? 1 : 7;

  // Build date params: either date_preset or time_range for custom periods
  function datePar(extra = {}) {
    if (isCustom) {
      const until = new Date();
      const since = new Date(until.getTime() - customDays * 86400000);
      const tr = JSON.stringify({
        since: since.toISOString().split('T')[0],
        until: until.toISOString().split('T')[0],
      });
      return { time_range: tr, ...extra };
    }
    return { date_preset: datePreset, ...extra };
  }

  // Comparison preset (previous period for delta indicators)
  const prevPreset = datePreset === 'last_7d'  ? 'last_14d'
    : datePreset === 'last_14d' ? 'last_month'
    : 'last_month';

  const [overviewCur, overviewPrev, campaignInsights, adsetInsights, adInsights, campaignsRaw, igData, dailyInsights] = await Promise.all([
    metaGet(`/${AD_ACCOUNT}/insights`, { fields: insightFields, ...datePar() }),
    metaGet(`/${AD_ACCOUNT}/insights`, { fields: insightFields, date_preset: prevPreset }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: campaignInsightFields,
      level: 'campaign', limit: 50, ...datePar(),
    }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: adsetInsightFields,
      level: 'adset', limit: 100, ...datePar(),
    }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: adInsightFields,
      level: 'ad', limit: 100, ...datePar(),
    }),
    metaGet(`/${AD_ACCOUNT}/campaigns`, {
      fields: 'id,name,status,objective,daily_budget,start_time',
      limit: 50,
    }),
    metaGet(`/${IG_ID}`, { fields: 'followers_count,media_count,name' }).catch(() => ({})),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: insightFields,
      time_increment: timeIncrement,
      limit: 100, ...datePar(),
    }),
  ]);

  const ov7  = overviewCur.data?.[0] || {};
  const ov14 = overviewPrev.data?.[0] || {};

  const spend7    = parseFloat(ov7.spend || 0);
  const spendPrev = parseFloat(ov14.spend || 0) - spend7;

  const acts7 = parseActions(ov7.actions);
  const messages   = acts7['onsite_conversion.messaging_conversation_started_7d'] || 0;
  const leads      = acts7['lead'] || 0;
  const videoViews = acts7['video_view'] || 0;

  const insightMap = {};
  for (const r of campaignInsights.data || []) insightMap[r.campaign_id] = r;

  // Adset map: campaignId -> array of adset insights
  const adsetMap = {};
  for (const r of adsetInsights.data || []) {
    if (!adsetMap[r.campaign_id]) adsetMap[r.campaign_id] = [];
    adsetMap[r.campaign_id].push(r);
  }

  const activeCampaigns  = (campaignsRaw.data || []).filter(c => c.status === 'ACTIVE');
  const pausedCampaigns  = (campaignsRaw.data || []).filter(c => c.status === 'PAUSED');
  const pausedWithData   = pausedCampaigns.filter(c => insightMap[c.id] && parseFloat(insightMap[c.id].spend || 0) > 0);

  const adsWithData = (adInsights.data || [])
    .filter(a => parseFloat(a.spend || 0) > 0.5)
    .sort((a, b) => parseFloat(b.ctr || 0) - parseFloat(a.ctr || 0));

  const dailyData = dailyInsights.data || [];

  return {
    ov7, ov14, spend7, spendPrev,
    messages, leads, videoViews,
    insightMap, adsetMap, activeCampaigns, pausedCampaigns, pausedWithData,
    adsWithData, igData, dailyData,
    ctr7: parseFloat(ov7.ctr || 0),
    cpm7: parseFloat(ov7.cpm || 0),
    datePreset,
  };
}

// ── DOCUMENT 1: Analytics ───────────────────────────────────────
export async function generateAnalyticsDoc(data) {
  const { ov7, spend7, spendPrev, messages, leads, videoViews,
          insightMap, activeCampaigns, pausedWithData, adsWithData, igData, dailyData, datePreset } = data;

  const dateStr   = new Date().toLocaleString('ru-RU');
  const dateShort = new Date().toLocaleDateString('ru-RU');
  const period    = `${new Date(Date.now()-6*86400000).toLocaleDateString('ru-RU')} — ${dateShort}`;

  // Generate charts
  const [spendChartBuf, ctrChartBuf, dailyChartBuf] = await Promise.all([
    makeSpendChart(activeCampaigns, insightMap).catch(() => null),
    makeCtrChart(activeCampaigns, insightMap).catch(() => null),
    makeDailySpendChart(dailyData).catch(() => null),
  ]);

  const children = [
    ...titlePage('📊 Аналитика рекламы', `Wallcov | ${period}`),

    // Instagram
    h2('🤳 Instagram'),
    makeTable(['Показатель', 'Значение'], [
      ['Аккаунт', igData.name || 'wallcov'],
      ['Подписчиков', (igData.followers_count||0).toLocaleString('ru-RU')],
      ['Публикаций', String(igData.media_count||0)],
    ], { colWidths: [3000, 5400] }),

    // Account overview
    h2('💼 Аккаунт — итого'),
    makeTable(['Метрика', 'Значение', 'vs предыдущий период'], [
      ['Расход', fmtMoney(spend7), spendPrev > 0 ? `+${fmtMoney(spendPrev)}` : spendPrev < 0 ? `${fmtMoney(spendPrev)}` : '—'],
      ['Охват', parseInt(ov7.reach||0).toLocaleString('ru-RU'), ''],
      ['Показы', parseInt(ov7.impressions||0).toLocaleString('ru-RU'), ''],
      ['Клики', parseInt(ov7.clicks||0).toLocaleString('ru-RU'), ''],
      ['CTR', `${fmt(ov7.ctr)}%`, ''],
      ['CPM', `$${fmt(ov7.cpm)}`, ''],
      ['CPC', `$${fmt(ov7.cpc)}`, ''],
      ['Частота', fmt(ov7.frequency), ''],
      ...(messages > 0 ? [['Диалогов (Messaging)', `${messages}`, `Цена диалога: ${fmtMoney(spend7/messages)}`]] : []),
      ...(leads > 0    ? [['Лидов', String(leads), `Цена лида: ${fmtMoney(spend7/leads)}`]] : []),
      ...(videoViews > 0 ? [['Просмотров видео', videoViews.toLocaleString('ru-RU'), '']] : []),
    ], { colWidths: [2200, 2000, 4200] }),
  ];

  // Daily spend chart
  if (dailyChartBuf) {
    children.push(h3('📈 Расход по дням'));
    const img = chartImage(dailyChartBuf);
    if (img) children.push(img);
  }

  // Active campaigns
  children.push(h2(`🚀 Активные кампании (${activeCampaigns.length})`));

  if (activeCampaigns.length > 0) {
    const campRows = activeCampaigns.map(c => {
      const ins = insightMap[c.id] || {};
      const days = Math.floor((Date.now() - new Date(c.start_time)) / 86400000);
      const learning = isLearning(c.start_time);
      const budget = c.daily_budget ? `$${(parseInt(c.daily_budget)/100).toFixed(0)}/д` : '—';
      const cActs = parseActions(ins.actions);
      const cMsg  = cActs['onsite_conversion.messaging_conversation_started_7d'] || 0;
      const ctr   = parseFloat(ins.ctr||0);
      const nameCell = {
        text: c.name + (learning ? ` 🔄 обуч.${days}д` : ''),
        bg: learning ? 'EAF6FF' : 'FFFFFF', bold: false,
      };
      const ctrCell = {
        text: `${fmt(ctr)}%`,
        bg:    ctr >= THRESHOLDS.CTR_WARN ? GREEN_BG : ctr >= THRESHOLDS.CTR_LOW ? YELLOW_BG : RED_BG,
        color: ctr >= THRESHOLDS.CTR_WARN ? GREEN    : ctr >= THRESHOLDS.CTR_LOW ? ORANGE    : RED,
        bold: true,
      };
      return [nameCell, budget, fmtMoney(ins.spend||0), ctrCell,
        `$${fmt(ins.cpm)}`, fmt(ins.frequency), cMsg > 0 ? String(cMsg) : '—'];
    });
    children.push(makeTable(
      ['Кампания', 'Бюджет', 'Расход', 'CTR', 'CPM', 'Частота', 'Диалоги'],
      campRows,
      { colWidths: [3000, 900, 1100, 800, 900, 900, 800] }
    ));

    // Spend chart
    if (spendChartBuf) {
      children.push(h3('💰 Расход по кампаниям'));
      const img = chartImage(spendChartBuf);
      if (img) children.push(img);
    }

    // CTR chart
    if (ctrChartBuf) {
      children.push(h3('📊 CTR по кампаниям'));
      const img = chartImage(ctrChartBuf);
      if (img) children.push(img);
    }
  } else {
    children.push(p('Нет активных кампаний', { italic: true, color: '888888' }));
  }

  // Paused with data
  if (pausedWithData.length > 0) {
    children.push(h2('⏸ Паузированные (с данными за период)'));
    children.push(makeTable(
      ['Кампания', 'Расход', 'CTR', 'CPM', 'Частота'],
      pausedWithData.map(c => {
        const ins = insightMap[c.id] || {};
        return [c.name, fmtMoney(ins.spend||0), `${fmt(ins.ctr)}%`, `$${fmt(ins.cpm)}`, fmt(ins.frequency)];
      }),
      { colWidths: [3800, 1200, 1000, 1200, 1200] }
    ));
  }

  // Top ads
  if (adsWithData.length > 0) {
    children.push(h2('🏆 Объявления — топ по CTR'));
    children.push(makeTable(
      ['Объявление', 'Кампания', 'CTR', 'CPM', 'Расход', 'Частота'],
      adsWithData.slice(0, 10).map(a => [
        a.ad_name.slice(0, 40),
        (a.campaign_name||'').slice(0, 28),
        { text: `${fmt(a.ctr)}%`, color: parseFloat(a.ctr||0) >= 2 ? GREEN : ORANGE },
        `$${fmt(a.cpm)}`,
        fmtMoney(a.spend),
        fmt(a.frequency),
      ]),
      { colWidths: [2800, 2400, 700, 900, 1000, 600] }
    ));
  }

  children.push(...footer(dateStr));

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const filePath = resolve(__dirname, `../tmp-analytics-${Date.now()}.docx`);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ── DOCUMENT 2: Recommendations (detailed) ───────────────────────
export async function generateRecommendationsDoc(data) {
  const { ov7, spend7, spendPrev, messages, leads,
          insightMap, adsetMap, activeCampaigns, pausedWithData, adsWithData, igData, dailyData, datePreset } = data;

  const dateStr   = new Date().toLocaleString('ru-RU');
  const dateShort = new Date().toLocaleDateString('ru-RU');
  const period    = `${new Date(Date.now()-6*86400000).toLocaleDateString('ru-RU')} — ${dateShort}`;

  const ctr7  = parseFloat(ov7.ctr||0);
  const cpm7  = parseFloat(ov7.cpm||0);
  const freq7 = parseFloat(ov7.frequency||0);

  // Pre-compute days count from datePreset
  const daysMap = {
    last_7d: 7, last_14d: 14, last_30d: 30,
    this_week: 7, last_week: 7, last_month: 30,
  };
  const periodDays = daysMap[datePreset] || 7;

  // Generate charts
  const allCampaigns = [...activeCampaigns, ...pausedWithData];
  const [spendChartBuf, ctrChartBuf, topAdsCtrBuf] = await Promise.all([
    makeSpendChart(allCampaigns, insightMap).catch(() => null),
    makeCtrChart(allCampaigns, insightMap).catch(() => null),
    makeTopAdsCtrChart(adsWithData).catch(() => null),
  ]);

  // Best and worst ads
  const top3Ads   = adsWithData.slice(0, 3);
  const worst3Ads = [...adsWithData]
    .sort((a, b) => parseFloat(a.ctr||0) - parseFloat(b.ctr||0))
    .slice(0, 3)
    .filter(a => parseFloat(a.ctr||0) < 2);

  // Priority action plan collected as we go
  const actionPlan = [];

  // Campaign analysis flags
  const campAnalysis = activeCampaigns.map(c => {
    const ins = insightMap[c.id] || {};
    const learning = isLearning(c.start_time);
    const ctr  = parseFloat(ins.ctr||0);
    const freq = parseFloat(ins.frequency||0);
    const acts = parseActions(ins.actions);
    const cMsg = acts['onsite_conversion.messaging_conversation_started_7d'] || 0;
    const budget = c.daily_budget ? (parseInt(c.daily_budget)/100).toFixed(0) : '?';
    const icon   = learning ? '🔄' : ctr >= THRESHOLDS.CTR_WARN ? '✅' : ctr >= THRESHOLDS.CTR_LOW ? '🟡' : '🔴';
    return { c, ins, learning, ctr, freq, cMsg, budget, icon, acts };
  });

  // Fill action plan based on campaign analysis
  for (const { c, learning, ctr, freq, icon, budget } of campAnalysis) {
    if (learning) continue;
    if (ctr > 0 && ctr < THRESHOLDS.CTR_LOW) {
      actionPlan.push({ action: `Поставить на паузу или заменить креативы в "${c.name.slice(0,30)}"`, who: 'Таргетолог', priority: '🔴 Срочно', deadline: 'Сегодня' });
    } else if (ctr < THRESHOLDS.CTR_WARN && ctr > 0) {
      actionPlan.push({ action: `Протестировать новые объявления в "${c.name.slice(0,30)}"`, who: 'Дизайнер + Таргетолог', priority: '🟡 Важно', deadline: '3 дня' });
    } else if (ctr >= THRESHOLDS.CTR_WARN) {
      actionPlan.push({ action: `Увеличить бюджет "${c.name.slice(0,30)}" на 20-30%`, who: 'Таргетолог', priority: '✅ Рекомендую', deadline: 'Эта неделя' });
    }
    if (freq >= THRESHOLDS.FREQ_HIGH) {
      actionPlan.push({ action: `Обновить аудиторию / расширить в "${c.name.slice(0,30)}"`, who: 'Таргетолог', priority: '🔴 Срочно', deadline: 'Сегодня' });
    }
  }
  if (top3Ads.length > 0) {
    actionPlan.push({ action: `Масштабировать лучшее объявление: "${top3Ads[0].ad_name.slice(0,30)}"`, who: 'Таргетолог', priority: '✅ Рекомендую', deadline: 'Эта неделя' });
  }
  actionPlan.push({ action: 'Настроить квалификационный вопрос в форме лидов Facebook', who: 'Таргетолог', priority: '🟡 Важно', deadline: 'Неделя' });
  actionPlan.push({ action: 'Запустить Messaging-кампанию вместо/вместе с лид-формами', who: 'Таргетолог', priority: '🟡 Важно', deadline: '2 недели' });

  // ─ Build document ─────────────────────────────────────────────
  const children = [
    ...titlePage('💡 Рекомендации по рекламе', 'Wallcov | Декоративная штукатурка, Украина', period),

    // ── РАЗДЕЛ 1: ОБЩИЙ РЕЗУЛЬТАТ ─────────────────────────────
    h1('📋 РАЗДЕЛ 1: ОБЩИЙ РЕЗУЛЬТАТ'),
  ];

  // Conversational paragraph
  const ctrEval = ctr7 >= THRESHOLDS.CTR_WARN
    ? `CTR аккаунта составил ${fmt(ctr7)}% — это хороший результат: каждые 100 показов дают больше 2 кликов, аудитория реагирует на рекламу.`
    : ctr7 >= THRESHOLDS.CTR_LOW
      ? `CTR аккаунта — ${fmt(ctr7)}%, что ниже нормы (цель: от 2%). Каждые 100 показов дают менее 2 кликов — это сигнал, что часть объявлений или аудиторий работает слабо.`
      : `CTR аккаунта — ${fmt(ctr7)}%, это критически низкий показатель. Меньше 1 клика на 100 показов означает, что реклама практически не привлекает внимание. Нужны срочные действия.`;

  const dialogEval = messages > 0
    ? `Получено ${messages} диалог${messages === 1 ? '' : messages < 5 ? 'а' : 'ов'} через Messaging, цена диалога — ${fmtMoney(spend7/messages)}.`
    : leads > 0
      ? `Получено ${leads} лид${leads === 1 ? '' : leads < 5 ? 'а' : 'ов'}, цена лида — ${fmtMoney(spend7/leads)}.`
      : 'Диалоги и лиды за период не зафиксированы — стоит проверить настройки отслеживания событий.';

  const freqEval = freq7 >= THRESHOLDS.FREQ_HIGH
    ? `Частота показов ${fmt(freq7)} — это высокий показатель: аудитория видит рекламу слишком часто, выгорание неизбежно. Нужно срочно расширить аудиторию или обновить креативы.`
    : freq7 >= THRESHOLDS.FREQ_WARN
      ? `Частота ${fmt(freq7)} — аудитория начинает "насыщаться". Пора готовить свежие креативы.`
      : `Частота ${fmt(freq7)} — нормальный уровень, аудитория не перегрета.`;

  children.push(
    p(`За прошедшие ${periodDays} дней вы потратили ${fmtMoney(spend7)} на рекламу. ${ctrEval} ${dialogEval} ${freqEval}`, { size: 22 }),
    divider(),
    makeTable(['Показатель', 'Факт', 'Оценка'], [
      ['Расход за период', fmtMoney(spend7), ''],
      ['CTR аккаунта', `${fmt(ctr7)}%`, { text: ctr7 >= 2 ? '✅ Хорошо' : ctr7 >= 1 ? '🟡 Ниже нормы' : '🔴 Критично', color: ctr7 >= 2 ? GREEN : ctr7 >= 1 ? ORANGE : RED, bold: true }],
      ['CPM', `$${fmt(cpm7)}`, ''],
      ['Средняя частота', fmt(freq7), { text: freq7 >= 3 ? '🔴 Выгорание' : freq7 >= 2 ? '🟡 Следи' : '✅ OK', color: freq7 >= 3 ? RED : freq7 >= 2 ? ORANGE : GREEN }],
      ...(messages > 0 ? [['Диалогов', String(messages), `Цена: ${fmtMoney(spend7/messages)}`]] : []),
      ...(leads > 0    ? [['Лидов', String(leads), `Цена: ${fmtMoney(spend7/leads)}`]] : []),
    ], { colWidths: [2500, 1800, 4100] }),
  );

  if (spendChartBuf) {
    children.push(h3('💰 Расход по кампаниям'));
    const img = chartImage(spendChartBuf);
    if (img) children.push(img);
  }

  // ── РАЗДЕЛ 2: КАМПАНИИ — ДЕТАЛЬНЫЙ РАЗБОР ───────────────────
  children.push(h1('🔍 РАЗДЕЛ 2: КАМПАНИИ — ДЕТАЛЬНЫЙ РАЗБОР'));

  if (campAnalysis.length === 0) {
    children.push(p('Активных кампаний за период не найдено.', { italic: true, color: '888888' }));
  }

  for (const { c, ins, learning, ctr, freq, cMsg, budget, icon } of campAnalysis) {
    const ctrColor = ctr >= THRESHOLDS.CTR_WARN ? GREEN : ctr >= THRESHOLDS.CTR_LOW ? ORANGE : RED;
    children.push(h2(`${icon} ${c.name}`, ctrColor));

    // Figures table
    children.push(makeTable(['Метрика', 'Значение'], [
      ['Расход', fmtMoney(ins.spend||0)],
      ['CTR', { text: `${fmt(ctr)}%`, color: ctrColor, bold: true }],
      ['CPM', `$${fmt(ins.cpm||0)}`],
      ['Частота', fmt(freq)],
      ['Диалоги', cMsg > 0 ? `${cMsg} (цена: ${fmtMoney(parseFloat(ins.spend||0)/cMsg)})` : '—'],
      ['Бюджет/день', `$${budget}`],
      ['Статус', learning ? '🔄 Обучение' : '🟢 Активна'],
    ], { colWidths: [2800, 5600] }));

    // Conversational explanation
    let ctrExpl = '';
    if (learning) {
      ctrExpl = `Кампания находится в фазе обучения — алгоритм Facebook только оптимизируется. Не делай резких изменений бюджета или таргетинга в этот период, иначе обучение начнётся заново.`;
    } else if (ctr >= THRESHOLDS.CTR_WARN) {
      ctrExpl = `CTR ${fmt(ctr)}% — отличный результат. Это значит, что каждые 100 показов дают ${fmt(ctr, 1)} кликов. Аудитория хорошо реагирует на объявления. Рекомендую увеличить бюджет на 20-30% и посмотреть, сохранится ли CTR при масштабировании.`;
    } else if (ctr >= THRESHOLDS.CTR_LOW) {
      ctrExpl = `CTR ${fmt(ctr)}% — ниже нормы. Каждые 100 показов дают ${fmt(ctr, 1)} кликов, что говорит о том, что объявление не достаточно цепляет аудиторию. Стоит протестировать другие форматы визуала или заголовка.`;
    } else if (ctr > 0) {
      ctrExpl = `CTR ${fmt(ctr)}% — критически низкий. На каждые 100 показов меньше 1 клика. Это дорогостоящий трафик без результата. Рекомендую поставить кампанию на паузу и пересмотреть либо аудиторию, либо креативы.`;
    } else {
      ctrExpl = `По кампании нет данных за период — возможно, она не откручивала показы.`;
    }

    let freqExpl = '';
    if (freq >= THRESHOLDS.FREQ_HIGH) {
      freqExpl = ` Частота ${fmt(freq)} — аудитория видит рекламу слишком часто. Это ведёт к раздражению и снижению CTR. Срочно расширь аудиторию или смени креативы.`;
    } else if (freq >= THRESHOLDS.FREQ_WARN) {
      freqExpl = ` Частота ${fmt(freq)} — на грани. Пора готовить новые объявления.`;
    }

    children.push(p(ctrExpl + freqExpl, { size: 22 }));

    // Adset table if available
    const adsets = adsetMap[c.id];
    if (adsets && adsets.length > 0) {
      children.push(h3('Адсеты этой кампании:'));
      children.push(makeTable(
        ['Адсет', 'Расход', 'CTR', 'CPM', 'Частота', 'Охват'],
        adsets.map(as => {
          const asCtr = parseFloat(as.ctr||0);
          return [
            as.adset_name.slice(0, 35),
            fmtMoney(as.spend||0),
            { text: `${fmt(asCtr)}%`, color: asCtr >= 2 ? GREEN : asCtr >= 1 ? ORANGE : RED, bold: true },
            `$${fmt(as.cpm||0)}`,
            fmt(as.frequency||0),
            parseInt(as.reach||0).toLocaleString('ru-RU'),
          ];
        }),
        { colWidths: [2400, 1000, 800, 1000, 1000, 1200] }
      ));
    }

    // Recommendation for this campaign
    let recText = '';
    if (learning) {
      recText = '⏳ Вывод: Подожди окончания обучения (7 дней от запуска) перед принятием решений.';
    } else if (ctr >= THRESHOLDS.CTR_WARN) {
      recText = `✅ Вывод: Масштабировать. Увеличить бюджет на 20-30%, следить за CTR при росте.`;
    } else if (ctr >= THRESHOLDS.CTR_LOW) {
      recText = `🟡 Вывод: Тестировать новые объявления. Оставить кампанию, но добавить 2-3 новых варианта объявлений.`;
    } else {
      recText = `🔴 Вывод: Поставить на паузу или срочно заменить объявления. Кампания тратит бюджет без эффекта.`;
    }
    children.push(p(recText, { bold: true, size: 22 }));
    children.push(divider());
  }

  // Paused with data
  if (pausedWithData.length > 0) {
    children.push(h2('⏸ Паузированные кампании (с данными за период)'));
    children.push(makeTable(
      ['Кампания', 'Расход', 'CTR', 'CPM', 'Частота'],
      pausedWithData.map(c => {
        const ins = insightMap[c.id] || {};
        return [c.name, fmtMoney(ins.spend||0), `${fmt(ins.ctr)}%`, `$${fmt(ins.cpm)}`, fmt(ins.frequency)];
      }),
      { colWidths: [3800, 1200, 1000, 1200, 1200] }
    ));
  }

  // ── РАЗДЕЛ 3: ОБЪЯВЛЕНИЯ ─────────────────────────────────────
  children.push(h1('📊 РАЗДЕЛ 3: ОБЪЯВЛЕНИЯ'));

  if (topAdsCtrBuf) {
    children.push(h3('🏆 CTR по объявлениям (топ-10)'));
    const img = chartImage(topAdsCtrBuf);
    if (img) children.push(img);
  }

  if (top3Ads.length > 0) {
    children.push(h2('✅ Топ-3 лучших объявления — почему работают'));
    for (let i = 0; i < top3Ads.length; i++) {
      const a = top3Ads[i];
      const ctr = parseFloat(a.ctr||0);
      children.push(h3(`${i+1}. ${a.ad_name.slice(0, 50)}`));
      children.push(makeTable(['Метрика', 'Значение'], [
        ['Кампания', a.campaign_name || '—'],
        ['Адсет', a.adset_name || '—'],
        ['CTR', { text: `${fmt(ctr)}%`, color: GREEN, bold: true }],
        ['CPM', `$${fmt(a.cpm)}`],
        ['Расход', fmtMoney(a.spend)],
        ['Частота', fmt(a.frequency)],
      ], { colWidths: [2400, 6000] }));

      let why = `CTR ${fmt(ctr)}% говорит о том, что это объявление хорошо цепляет целевую аудиторию. `;
      if (ctr >= 3) {
        why += 'Такой высокий CTR обычно указывает на очень точное попадание визуала и/или текста в боль или интерес аудитории. Это объявление стоит масштабировать и использовать как эталон для новых тестов.';
      } else {
        why += 'Объявление превышает средний по аккаунту CTR. Обрати внимание на то, что в нём работает: это может быть конкретный заголовок, формат (карусель/видео/фото), или совпадение с интересами аудитории адсета.';
      }
      children.push(p(why, { size: 22 }));
      children.push(p(`Рекомендация: Дублировать объявление в другие адсеты. Увеличить бюджет адсета "${(a.adset_name||'').slice(0,35)}" на 20-30%.`, { bold: true }));
      children.push(divider());
    }
  }

  if (worst3Ads.length > 0) {
    children.push(h2('🔴 3 слабейших объявления — что не так и что изменить'));
    for (let i = 0; i < worst3Ads.length; i++) {
      const a = worst3Ads[i];
      const ctr = parseFloat(a.ctr||0);
      children.push(h3(`${i+1}. ${a.ad_name.slice(0, 50)}`));
      children.push(makeTable(['Метрика', 'Значение'], [
        ['Кампания', a.campaign_name || '—'],
        ['CTR', { text: `${fmt(ctr)}%`, color: RED, bold: true }],
        ['Расход', fmtMoney(a.spend)],
        ['CPM', `$${fmt(a.cpm)}`],
      ], { colWidths: [2400, 6000] }));

      let problem = `CTR ${fmt(ctr)}% — объявление не привлекает клики при нормальных показах. `;
      if (ctr < 0.5) {
        problem += 'Это означает острую проблему: либо аудитория совсем не та, либо визуал/текст не вызывает никакой реакции.';
      } else {
        problem += 'Объявление показывается, но аудитория не кликает — скорее всего, нет чёткого призыва к действию или офер непонятен.';
      }
      children.push(p(problem, { size: 22 }));
      children.push(p('Что изменить: 1) Проверь первые 3 секунды видео / первый экран фото — они должны сразу захватывать внимание. 2) Сделай заголовок конкретнее — избегай абстракций, говори о выгоде. 3) Добавь социальное доказательство (отзыв, цифра, результат). 4) Если не помогает — отключить объявление и перераспределить бюджет.', { italic: true, color: '555555' }));
      children.push(divider());
    }
  }

  // ── РАЗДЕЛ 4: ДЛЯ ТАРГЕТОЛОГА ───────────────────────────────
  children.push(h1('🎯 РАЗДЕЛ 4: ДЛЯ ТАРГЕТОЛОГА'));

  children.push(h2('Аудитории'));
  const audienceRecs = [];
  for (const { c, ctr, freq, learning } of campAnalysis) {
    if (learning) continue;
    if (freq >= THRESHOLDS.FREQ_HIGH) {
      audienceRecs.push(`▸ "${c.name.slice(0,40)}" — частота ${fmt(freq)}, аудитория выгорела. Расширь географию, возраст или добавь Lookalike аудиторию.`);
    } else if (ctr < THRESHOLDS.CTR_LOW && ctr > 0) {
      audienceRecs.push(`▸ "${c.name.slice(0,40)}" — CTR ${fmt(ctr)}%, возможно аудитория нерелевантна. Проверь интересы и сузь таргетинг.`);
    }
  }
  if (audienceRecs.length === 0) {
    audienceRecs.push('▸ Аудитории в норме. Для роста рекомендуй протестировать Broad аудиторию (без детального таргетинга) — Facebook сам найдёт похожих пользователей.');
  }
  for (const r of audienceRecs) children.push(p(r, { size: 22 }));

  children.push(h2('Бюджеты'));
  const budgetRecs = [];
  for (const { c, ctr, budget, learning } of campAnalysis) {
    if (learning) continue;
    if (ctr >= THRESHOLDS.CTR_WARN) {
      budgetRecs.push(`▸ Увеличить бюджет "${c.name.slice(0,35)}" — с $${budget}/д на $${Math.round(parseFloat(budget)*1.3)}/д (+30%)`);
    } else if (ctr < THRESHOLDS.CTR_LOW && ctr > 0) {
      budgetRecs.push(`▸ Заморозить или снизить бюджет "${c.name.slice(0,35)}" до $5-10/д пока не найдёт работающий креатив`);
    }
  }
  if (budgetRecs.length === 0) {
    budgetRecs.push('▸ Бюджеты распределены нормально. Рекомендую тестировать новые объявления с бюджетом $5-10/день перед масштабированием.');
  }
  for (const r of budgetRecs) children.push(p(r, { size: 22 }));

  children.push(h2('Стратегии ставок'));
  children.push(p('▸ Для Messaging кампаний: используй Lowest Cost (минимальная цена) без кэпа — Facebook оптимизирует сам.', { size: 22 }));
  children.push(p('▸ Если цена диалога растёт — попробуй Cost Cap с целевой ценой $2-3 за диалог.', { size: 22 }));
  children.push(p('▸ Для кампаний с лидами: тест Conversion Value Optimization если Facebook предлагает.', { size: 22 }));

  children.push(h2('Конкретные проблемы с числами'));
  if (ctr7 < THRESHOLDS.CTR_LOW) {
    children.push(p(`▸ Средний CTR аккаунта ${fmt(ctr7)}% — срочно нужен аудит объявлений. Цель: довести до 1.5% за 2 недели тестов.`, { size: 22, color: RED }));
  }
  if (freq7 >= THRESHOLDS.FREQ_WARN) {
    children.push(p(`▸ Частота ${fmt(freq7)} — расширяй аудитории или меняй креативы каждые 7-10 дней.`, { size: 22, color: ORANGE }));
  }
  if (cpm7 > 10) {
    children.push(p(`▸ CPM $${fmt(cpm7)} — высокий для Украины. Попробуй уменьшить конкуренцию за аудиторию: Broad вместо узкого таргетинга.`, { size: 22 }));
  }

  // ── РАЗДЕЛ 5: ДЛЯ ДИЗАЙНЕРА / СОЗДАТЕЛЯ КОНТЕНТА ───────────
  children.push(h1('🎨 РАЗДЕЛ 5: ДЛЯ ДИЗАЙНЕРА / СОЗДАТЕЛЯ КОНТЕНТА'));

  children.push(h2('Что работает в текущих креативах'));
  if (top3Ads.length > 0) {
    children.push(p(`▸ Лучшее объявление "${top3Ads[0].ad_name.slice(0,45)}" — CTR ${fmt(parseFloat(top3Ads[0].ctr||0))}%. Это эталон — изучи, что в нём зацепило.`, { size: 22 }));
  }
  children.push(p('▸ Обрати внимание на объявления с CTR выше 2% — в них есть что-то правильное: конкретный визуал, понятный оффер, или правильный формат.', { size: 22 }));

  children.push(h2('Что не работает и почему'));
  if (worst3Ads.length > 0) {
    children.push(p(`▸ Объявление "${worst3Ads[0].ad_name.slice(0,45)}" — CTR ${fmt(parseFloat(worst3Ads[0].ctr||0))}%. Скорее всего: слабый крючок в начале, абстрактный заголовок, или нет чёткого призыва.`, { size: 22 }));
  }
  children.push(p('▸ Общая проблема слабых объявлений: отсутствие конкретики. "Красиво и качественно" не продаёт. Продаёт: конкретный результат, конкретная выгода, конкретный отзыв.', { size: 22 }));

  children.push(h2('Идеи для новых форматов'));
  const creativeIdeas = [
    '▸ Видео "до/после": процесс нанесения штукатурки + финальный результат. Показывай трансформацию стены за 15-30 секунд.',
    '▸ Карусель с примерами: 5-6 разных фактур/цветов в реальных интерьерах. Каждый слайд = отдельная идея для клиента.',
    '▸ Видео отзыв реального заказчика: "Заказали у Wallcov, вот что получили". 30-60 секунд, снятое на телефон — живые видео часто работают лучше студийных.',
    '▸ Reels с процессом: timelapse нанесения — выглядит как магия и очень хорошо вирусится в Instagram.',
    '▸ Сравнение: Wallcov vs обычная краска/обои — почему это лучший выбор для фасада.',
  ];
  for (const idea of creativeIdeas) children.push(p(idea, { size: 22 }));

  children.push(h2('На что обратить внимание в следующих креативах'));
  children.push(p('▸ Первые 3 секунды видео решают всё — начинай с самого эффектного кадра, а не с логотипа.', { size: 22 }));
  children.push(p('▸ Текст на украинском языке — аудитория в Украине лучше реагирует на родной язык.', { size: 22 }));
  children.push(p('▸ Используй реальные объекты, не рендеры — живые фотографии вызывают больше доверия.', { size: 22 }));
  children.push(p('▸ Добавляй конкретику: "Фасад на 200 м² за 3 дня", "Гарантия 10 лет".', { size: 22 }));

  // ── РАЗДЕЛ 6: ГИПОТЕЗЫ ───────────────────────────────────────
  children.push(h1('🧪 РАЗДЕЛ 6: ГИПОТЕЗЫ ДЛЯ ТЕСТИРОВАНИЯ'));

  const hypotheses = [
    ['1', 'Broad аудитория (без интересов) vs текущий таргетинг', 'Запустить кампанию без детального таргетинга, только страна + возраст', 'Сравнить CTR и цену диалога через 7 дней', 'CTR ≥ текущего, цена диалога ≤ $3'],
    ['2', 'Видеоформат vs статика', 'Запустить те же оферы в формате видео 15-30 сек рядом со статичными изображениями', 'CTR и Engagement Rate через 7 дней', 'Видео даёт CTR на 30%+ выше'],
    ['3', 'Messaging вместо Lead Form', 'Запустить Messaging-кампанию (цель: диалог в Директ) вместо формы лидов', 'Количество и качество диалогов vs старая форма', 'Больше живых диалогов, меньше пустых заявок'],
    ['4', 'Lookalike аудитория на базе покупателей', 'Создать аудиторию похожих на текущих клиентов (LAL 1-3%)', 'CTR и цену лида/диалога через 10 дней', 'CTR > 2%, цена диалога ≤ $2.5'],
    ['5', 'Квалификационный вопрос в лид-форме', 'Добавить вопрос "Ваш объект: квартира/дом/коммерция?" перед формой', 'Количество лидов vs качество (сколько ответили по телефону)', 'Лидов меньше, но качество выше — больше сделок'],
    ['6', 'Украинский vs русский язык в текстах', 'Одинаковые объявления с текстами на укр. и рус. языках', 'CTR по группам через 5 дней', 'Украинский язык показывает CTR на 15%+ выше'],
    ['7', 'Ретаргетинг на посетителей сайта', 'Запустить отдельную кампанию на тех, кто был на сайте последние 30 дней', 'CTR и конверсию ретаргетинг vs холодная аудитория', 'CTR в 2-3 раза выше холодного трафика'],
  ];

  children.push(makeTable(
    ['№', 'Гипотеза', 'Что тестируем', 'Как проверим', 'Ожидаем'],
    hypotheses,
    { colWidths: [400, 2000, 2000, 2000, 2000] }
  ));

  // ── РАЗДЕЛ 7: FACEBOOK ЛИДЫ — СПЕЦИАЛЬНЫЙ АНАЛИЗ ─────────────
  children.push(h1('💬 РАЗДЕЛ 7: FACEBOOK ЛИДЫ — СПЕЦИАЛЬНЫЙ АНАЛИЗ'));
  children.push(p('Контекст: ранее лид-формы давали пустые и нерелевантные заявки. Разбираем почему и как это исправить.', { italic: true, color: '555555', size: 22 }));

  children.push(h2('Почему Facebook лиды часто дают пустые заявки'));
  const leadProblems = [
    '▸ Мгновенная форма (Instant Form) слишком проста: Facebook предзаполняет поля автоматически, и пользователь нажимает "Отправить" почти не читая — часто случайно.',
    '▸ Аудитория нецелевая: если таргетинг слишком широкий, лиды оставляют люди, которые вообще не нуждаются в продукте.',
    '▸ Оффер слабый: форма не объясняет, ЗАЧЕМ оставлять заявку — нет чёткой выгоды.',
    '▸ Низкий порог входа: нет квалификационных вопросов, поэтому любой может заполнить форму.',
    '▸ Медленная обработка: если менеджер звонит через несколько часов, человек уже забыл что кликал.',
  ];
  for (const item of leadProblems) children.push(p(item, { size: 22 }));

  children.push(h2('Гипотезы — что пошло не так'));
  children.push(p('▸ Форма была слишком простой (только имя и телефон) — нет фильтрации нецелевых.', { size: 22 }));
  children.push(p('▸ Аудитория была широкой — люди оставляли заявку "на всякий случай".', { size: 22 }));
  children.push(p('▸ Не было чёткого оффера в тексте формы (что именно получу, оставив заявку?).', { size: 22 }));

  children.push(h2('5 конкретных шагов как исправить'));

  children.push(h3('Шаг 1: Переработать форму лида'));
  children.push(p('Убрать: автозаполнение без подтверждения. Добавить: поле "Тип объекта" (квартира/дом/коммерция), поле "Площадь (м²)", чёткий оффер в заголовке формы: "Получи расчёт стоимости фасада за 24 часа".', { size: 22 }));

  children.push(h3('Шаг 2: Instant Form vs Website — когда что работает'));
  children.push(p('Instant Form (лид-форма в Facebook): хорошо работает для тёплой аудитории и ретаргетинга. Для холодного трафика — слишком низкий порог. Website конверсия: лучше для осознанного решения, человек переходит на сайт и изучает. Решение: тест Instant Form (ретаргетинг) + Website (холодный трафик).', { size: 22 }));

  children.push(h3('Шаг 3: Квалификационный вопрос в форме'));
  children.push(p('Добавь обязательный вопрос с вариантами ответа: "Когда планируете ремонт?" → Сейчас / В этом году / Просто смотрю. Это автоматически отфильтрует нецелевые заявки.', { size: 22 }));

  children.push(h3('Шаг 4: Скорость обработки лида'));
  children.push(p('Идеально — звонок в течение 5 минут после заявки. Через 30 минут конверсия в сделку падает в разы. Настрой уведомления в Zapier или CRM, чтобы менеджер получал моментальный сигнал о новом лиде.', { size: 22 }));

  children.push(h3('Шаг 5: Альтернатива — Messaging кампании'));
  children.push(p('Вместо лид-формы запусти кампанию с целью "Сообщения" (Messaging). Пользователь попадает напрямую в Директ — это живой диалог, который легче квалифицировать. Менеджер сразу понимает, целевой ли клиент. Протестируй бюджет $10-15/день и сравни стоимость диалога vs стоимость лида.', { size: 22 }));

  // Lead data if available
  if (leads > 0) {
    const cpl = spend7 / leads;
    children.push(h2('Анализ текущих данных по лидам'));
    children.push(makeTable(['Метрика', 'Значение', 'Оценка'], [
      ['Лидов за период', String(leads), ''],
      ['Цена лида', fmtMoney(cpl), { text: cpl < 5 ? '✅ Хорошо' : cpl < 10 ? '🟡 Приемлемо' : '🔴 Дорого', color: cpl < 5 ? GREEN : cpl < 10 ? ORANGE : RED }],
      ...(messages > 0 ? [['Цена диалога (Messaging)', fmtMoney(spend7/messages), 'Сравни с ценой лида']] : []),
    ], { colWidths: [2500, 2000, 3900] }));
    if (messages > 0) {
      const ratio = cpl / (spend7/messages);
      children.push(p(`Лид стоит в ${fmt(ratio, 1)}x ${ratio > 1 ? 'дороже' : 'дешевле'} диалога. ${ratio > 1.5 ? 'Рекомендую перераспределить бюджет в пользу Messaging.' : 'Оба канала работают — продолжай тест.'}`, { size: 22 }));
    }
  }

  // ── РАЗДЕЛ 8: ПРИОРИТЕТНЫЙ ПЛАН ДЕЙСТВИЙ ────────────────────
  children.push(h1('📌 РАЗДЕЛ 8: ПРИОРИТЕТНЫЙ ПЛАН ДЕЙСТВИЙ'));

  if (actionPlan.length > 0) {
    children.push(makeTable(
      ['Действие', 'Кто делает', 'Приоритет', 'Срок'],
      actionPlan.map(a => [
        a.action,
        a.who,
        { text: a.priority, color: a.priority.startsWith('🔴') ? RED : a.priority.startsWith('🟡') ? ORANGE : GREEN, bold: true },
        a.deadline,
      ]),
      { colWidths: [3400, 1800, 1600, 1600] }
    ));
  } else {
    children.push(p('Критических проблем не обнаружено. Продолжай мониторинг и тестирование.', { italic: true }));
  }

  children.push(...footer(dateStr));

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const filePath = resolve(__dirname, `../tmp-recommendations-${Date.now()}.docx`);
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Generate both docs, upload to Drive, return links
 */
export async function generateAndUpload(datePreset = 'last_7d') {
  const { uploadReport } = await import('./drive-upload.js');

  console.log(`Fetching data (preset: ${datePreset})...`);
  const data = await fetchAllData(datePreset);
  const dateStr = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');

  console.log('Generating analytics doc...');
  const analyticsPath = await generateAnalyticsDoc(data);

  console.log('Generating recommendations doc...');
  const recsPath = await generateRecommendationsDoc(data);

  console.log('Uploading to Drive...');
  const analyticsResult = await uploadReport(analyticsPath, `${dateStr}-аналитика.docx`);
  const recsResult = await uploadReport(recsPath, `${dateStr}-рекомендации.docx`, analyticsResult.monthFolder);

  try { unlinkSync(analyticsPath); } catch {}
  try { unlinkSync(recsPath); } catch {}

  return {
    analyticsLink: analyticsResult.fileLink,
    recsLink: recsResult.fileLink,
    folderLink: analyticsResult.folderLink,
  };
}

/**
 * Generate both docs locally (no Drive upload), return file paths
 */
export async function generateBothLocal(datePreset = 'last_7d') {
  const data = await fetchAllData(datePreset);
  const [analyticsPath, recsPath] = await Promise.all([
    generateAnalyticsDoc(data),
    generateRecommendationsDoc(data),
  ]);
  return { analyticsPath, recsPath, data };
}
