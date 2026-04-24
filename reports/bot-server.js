#!/usr/bin/env node
import TelegramBot from 'node-telegram-bot-api';
import { readFileSync, writeFileSync, unlinkSync, createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateBothLocal, generateAndUpload, fetchAllData } from './generate-reports.js';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID;
const TG_PERSONAL     = process.env.TELEGRAM_PERSONAL_CHAT_ID || ''; // personal DM for critical alerts
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const IG_ID      = process.env.META_IG_ACCOUNT_ID;
const API_VER    = process.env.META_API_VERSION || 'v21.0';
const BASE_URL   = `https://graph.facebook.com/${API_VER}`;
const SHEET_URL  = 'https://docs.google.com/spreadsheets/d/1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';
const SHEET_ID   = '1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';
const MONTH_NAMES_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

// ── Google Sheets client (lazy init) ──────────────────────────
let sheetsClient = null;
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  try {
    const tokenPath = resolve(__dirname, '../sheets-token.json');
    const tokens    = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    const oauth2    = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oauth2.setCredentials(tokens);
    oauth2.on('tokens', (t) => {
      if (t.refresh_token) tokens.refresh_token = t.refresh_token;
      tokens.access_token = t.access_token;
      tokens.expiry_date  = t.expiry_date;
      writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    });
    sheetsClient = google.sheets({ version: 'v4', auth: oauth2 });
  } catch (e) {
    console.warn('⚠️ Sheets client init failed:', e.message);
  }
  return sheetsClient;
}

// Helper: column letter from 0-based index (A=0, B=1, ..., Z=25, AA=26, AB=27...)
function colLetterByIndex(idx) {
  let s = ''; idx += 1;
  while (idx > 0) { const r = (idx-1)%26; s = String.fromCharCode(65+r)+s; idx = Math.floor((idx-1)/26); }
  return s;
}

// ── Save yesterday's data to monthly Google Sheet ─────────────
// Called from sendMorningReport() after fetching yesterday data
// igFollowers: net daily follower change (from IG Insights); write only if > 0
async function saveDailyToSheet(date, campInsightsData, campaignsData, igFollowers) {
  const sh = getSheetsClient();
  if (!sh) return; // no auth → skip silently

  const day = date.getDate(); // 1-based day of month
  // B = day 1, C = day 2, ... AE = day 30/31
  const col = colLetterByIndex(day); // day=1 → index=1 → B ✓

  const months = MONTH_NAMES_RU;
  const sheetName = `${months[date.getMonth()]} ${date.getFullYear()}`;

  // Check sheet exists
  try {
    await sh.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${sheetName}'!A1` });
  } catch {
    console.warn(`⚠️ Sheet "${sheetName}" not found — skipping daily save`);
    return;
  }

  // Build a map: campaign_id → objective
  const objMap = {};
  for (const c of (campaignsData || [])) objMap[c.id] = c.objective || '';

  // Aggregate by type: Direct = everything except OUTCOME_TRAFFIC
  let dSpend=0, dImpr=0, dReach=0, dClicks=0, dResults=0;
  let tSpend=0, tImpr=0, tReach=0, tClicks=0;

  for (const ins of (campInsightsData || [])) {
    const obj    = objMap[ins.campaign_id] || '';
    const spend  = parseFloat(ins.spend || 0);
    const impr   = parseInt(ins.impressions || 0);
    const reach  = parseInt(ins.reach || 0);
    const clicks = parseInt(ins.clicks || 0);
    const acts   = parseActions(ins.actions);
    const results = (acts['onsite_conversion.messaging_conversation_started_7d'] || 0) + (acts['lead'] || 0);

    if (obj === 'OUTCOME_TRAFFIC') {
      tSpend += spend; tImpr += impr; tReach += reach; tClicks += clicks;
    } else {
      dSpend += spend; dImpr += impr; dReach += reach; dClicks += clicks; dResults += results;
    }
  }

  // Derived metrics
  const dCPM = dImpr  > 0 ? dSpend  / dImpr  * 1000 : 0;
  const dCPC = dClicks > 0 ? dSpend  / dClicks : 0;
  const dCTR = dImpr  > 0 ? dClicks / dImpr  * 100  : 0;
  const dCR  = dClicks > 0 ? dResults/ dClicks * 100 : 0;
  const dCPL = dResults > 0 ? dSpend / dResults : 0;
  const tCPM = tImpr  > 0 ? tSpend  / tImpr  * 1000 : 0;
  const tCPC = tClicks > 0 ? tSpend  / tClicks : 0;
  const tCTR = tImpr  > 0 ? tClicks / tImpr  * 100  : 0;
  const tCPL = tClicks > 0 ? tSpend  / tClicks : 0;
  const totalSpend = dSpend + tSpend;
  const totalCPL   = dResults > 0 ? totalSpend / dResults : 0;

  const n = v => Math.round(v * 10000) / 10000; // round to 4 decimals

  const rows = [
    // Direct
    [3,  n(dSpend)  ], [4,  dImpr    ], [5,  dReach   ], [6,  dClicks ],
    [8,  n(dCPM)   ], [9,  n(dCPC)  ], [10, n(dCTR)  ], [11, n(dCR)  ],
    [13, dResults  ], [14, n(dCPL)  ],
    // Traffic
    [18, n(tSpend) ], [19, tImpr    ], [20, tReach   ], [21, tClicks  ],
    [23, n(tCPM)  ], [24, n(tCPC)  ], [25, n(tCTR)  ],
    [27, tClicks  ], [28, n(tCPL)  ],
    // Totals
    [32, n(totalSpend)], [33, n(totalCPL)],
    [34, dImpr + tImpr], [35, dReach + tReach], [36, dClicks + tClicks],
  ];

  // Row 37: Instagram daily net followers — only write when API has real data (> 0)
  if (igFollowers !== undefined && igFollowers !== null && igFollowers > 0) {
    rows.push([37, igFollowers]);
  }

  const data = rows.map(([row, val]) => ({
    range: `'${sheetName}'!${col}${row}`,
    values: [[val]],
  }));

  await sh.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  console.log(`✅ Daily data saved to "${sheetName}" column ${col} (${date.toLocaleDateString('ru-RU')})`);
}

// Wizard states per chat
const wizardState = new Map();

// Pending action (period selection flow)
// Map<chatId, { action: 'full_report'|'upload_drive' }>
const pendingAction = new Map();

const bot = new TelegramBot(TG_TOKEN, { polling: true });

// ── Data cache (30 min TTL, per period) ──────────────────────
const dataCache    = new Map(); // datePreset -> { data, time }
const CACHE_TTL_MS = 30 * 60 * 1000;

async function getDataWithCache(datePreset = 'last_30d') {
  const cached = dataCache.get(datePreset);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.data;
  const data = await fetchAllData(datePreset);
  dataCache.set(datePreset, { data, time: Date.now() });
  return data;
}

// ── Detect period from user message ──────────────────────────
const RU_NUM_WORDS = {
  один: 1, одного: 1, одну: 1,
  два: 2, двух: 2, двое: 2,
  три: 3, трёх: 3, трех: 3,
  четыре: 4, четырёх: 4,
  пять: 5, пяти: 5,
  шесть: 6, шести: 6,
  семь: 7, семи: 7,
  восемь: 8, восьми: 8,
  девять: 9, девяти: 9,
  десять: 10, десяти: 10,
};

function detectPeriod(text) {
  const t = text.toLowerCase();
  // Long periods first (more specific) to avoid false matches
  if (t.match(/пол\s*года|полгода|6\s*мес|180\s*дн/)) return 'last_6m';
  if (t.match(/90\s*дн|3\s*мес|квартал/))             return 'last_90d';
  if (t.match(/прошл\w*\s+недел|last.?week/))   return 'last_week';
  if (t.match(/прошл\w*\s+месяц|прошлого месяца|last.?month/)) return 'last_month';
  if (t.match(/эт[ойа]\s+неделе?|эту неделю|текущ[аяой]\s+неделе?|this.?week/)) return 'this_week';
  if (t.match(/30\s*дн|за\s*месяц|этот\s*месяц|последний\s*месяц/)) return 'last_30d';
  if (t.match(/14\s*дн|две?\s*недели/)) return 'last_14d';
  if (t.match(/7\s*дн|за неделю|эту неделю/))         return 'last_7d';

  // Generic "N дней/дня/день" — цифры или русские числительные
  const digitMatch = t.match(/(\d+)\s*дн/);
  if (digitMatch) return `last_${digitMatch[1]}d`;

  const wordKeys = Object.keys(RU_NUM_WORDS).join('|');
  const wordMatch = t.match(new RegExp(`(${wordKeys})\\s*дн`));
  if (wordMatch) return `last_${RU_NUM_WORDS[wordMatch[1]]}d`;

  return 'last_30d'; // default: 30 дней — больше контекста для анализа
}

// ── Human-readable period name (handles dynamic last_Nd) ─────
function getPeriodName(datePreset) {
  if (PERIOD_NAMES[datePreset]) return PERIOD_NAMES[datePreset];
  const m = datePreset.match(/^last_(\d+)d$/);
  if (m) return `последние ${m[1]} дн.`;
  return datePreset;
}

const PERIOD_NAMES = {
  last_7d:    'последние 7 дней',
  last_14d:   'последние 14 дней',
  last_30d:   'последние 30 дней',
  last_90d:   'последние 90 дней',
  last_6m:    'последние 6 месяцев',
  this_week:  'эта неделя',
  last_week:  'прошлая неделя',
  last_month: 'прошлый месяц',
};

// ── Period mapping ────────────────────────────────────────────
const PERIOD_MAP = {
  period_7d:         'last_7d',
  period_14d:        'last_14d',
  period_30d:        'last_30d',
  period_90d:        'last_90d',
  period_6m:         'last_6m',
  period_this_week:  'this_week',
  period_last_week:  'last_week',
  period_last_month: 'last_month',
};

const PERIOD_LABELS = {
  last_7d:    '7 дней',
  last_14d:   '14 дней',
  last_30d:   '30 дней',
  last_90d:   '90 дней',
  last_6m:    '6 месяцев',
  this_week:  'эта неделя',
  last_week:  'прошлая неделя',
  last_month: 'прошлый месяц',
};

const PERIOD_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '7 дней',         callback_data: 'period_7d' },
      { text: '14 дней',        callback_data: 'period_14d' },
    ],
    [
      { text: '30 дней',        callback_data: 'period_30d' },
      { text: '90 дней',        callback_data: 'period_90d' },
    ],
    [
      { text: '6 месяцев',      callback_data: 'period_6m' },
      { text: 'Эта неделя',     callback_data: 'period_this_week' },
    ],
    [
      { text: 'Прошлая неделя', callback_data: 'period_last_week' },
      { text: 'Прошлый месяц',  callback_data: 'period_last_month' },
    ],
    [{ text: '❌ Отмена', callback_data: 'period_cancel' }],
  ],
};

// ── Meta API helper ──────────────────────────────────────────
async function metaGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  return res.json();
}

async function metaPost(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'POST' });
  return res.json();
}

function fmt(n, d = 2) { return parseFloat(n || 0).toFixed(d); }
function fmtMoney(n)   { return `$${fmt(n)}`; }
function parseActions(actions) {
  const map = {};
  for (const a of actions || []) map[a.action_type] = parseFloat(a.value) || 0;
  return map;
}

// ── Claude AI chat ─────────────────────────────────────────────
function buildDataSummary(data) {
  if (!data) return 'Данные не загружены.';
  const {
    ov7, ov14, spend7, spendPrev,
    messages, leads, videoViews,
    activeCampaigns, pausedWithData, insightMap, adsetMap, adsWithData,
    igData, dailyData, datePreset,
  } = data;

  const periodName = getPeriodName(datePreset);
  const spendChange = spendPrev !== 0
    ? ` (${spendPrev > 0 ? '+' : ''}$${fmt(spendPrev)} vs предыдущий период)`
    : '';

  const lines = [
    `=== ДАННЫЕ АККАУНТА: ${periodName.toUpperCase()} ===`,
    '',
    `ОБЩИЕ ПОКАЗАТЕЛИ:`,
    `  Расход: $${fmt(spend7)}${spendChange}`,
    `  CTR: ${fmt(ov7.ctr)}%  |  CPM: $${fmt(ov7.cpm)}  |  CPC: $${fmt(ov7.cpc)}`,
    `  Частота: ${fmt(ov7.frequency)}  |  Охват: ${parseInt(ov7.reach||0).toLocaleString()}  |  Показы: ${parseInt(ov7.impressions||0).toLocaleString()}`,
    messages > 0 ? `  Диалогов Messaging: ${messages} (цена диалога: $${fmt(spend7/messages)})` : `  Диалогов Messaging: 0`,
    leads > 0    ? `  Лидов (форма): ${leads} (цена лида: $${fmt(spend7/leads)})` : `  Лидов (форма): 0`,
    videoViews > 0 ? `  Просмотров видео: ${videoViews.toLocaleString()}` : '',
  ].filter(l => l !== '');

  // Active campaigns with adsets
  lines.push('', `АКТИВНЫЕ КАМПАНИИ (${activeCampaigns.length}):`);
  for (const c of activeCampaigns) {
    const ins = insightMap[c.id] || {};
    const budget = c.daily_budget ? `$${(parseInt(c.daily_budget)/100).toFixed(0)}/д` : '—';
    const days = c.start_time ? Math.floor((Date.now() - new Date(c.start_time)) / 86400000) : 0;
    const learning = days < 7 ? ` [ОБУЧЕНИЕ ${days}д]` : '';
    const acts = parseActions(ins.actions);
    const cMsg = acts['onsite_conversion.messaging_conversation_started_7d'] || 0;
    lines.push(`  ▸ ${c.name}${learning}`);
    lines.push(`    Бюджет: ${budget} | Расход: $${fmt(ins.spend)} | CTR: ${fmt(ins.ctr)}% | CPM: $${fmt(ins.cpm)} | Частота: ${fmt(ins.frequency)}${cMsg > 0 ? ` | Диалогов: ${cMsg}` : ''}`);

    // Adsets for this campaign
    const adsets = adsetMap?.[c.id] || [];
    if (adsets.length > 0) {
      lines.push(`    Группы объявлений (${adsets.length}):`);
      for (const as of adsets) {
        lines.push(`      • ${as.adset_name}: CTR ${fmt(as.ctr)}%, расход $${fmt(as.spend)}, частота ${fmt(as.frequency)}`);
      }
    }
  }

  // Paused campaigns that had spend
  if (pausedWithData && pausedWithData.length > 0) {
    lines.push('', `ПРИОСТАНОВЛЕННЫЕ (с расходом за период, ${pausedWithData.length}):`);
    for (const c of pausedWithData) {
      const ins = insightMap[c.id] || {};
      lines.push(`  ▸ ${c.name}: расход $${fmt(ins.spend)}, CTR ${fmt(ins.ctr)}%`);
    }
  }

  // Ads performance
  if (adsWithData && adsWithData.length > 0) {
    const top5 = adsWithData.slice(0, 5);
    const worst3 = [...adsWithData].sort((a,b) => parseFloat(a.ctr||0)-parseFloat(b.ctr||0)).slice(0,3).filter(a=>parseFloat(a.ctr||0)>0);
    lines.push('', `ОБЪЯВЛЕНИЯ — ТОП-5 ПО CTR:`);
    for (const a of top5) {
      lines.push(`  ✅ "${a.ad_name.slice(0,45)}" — CTR ${fmt(a.ctr)}%, расход $${fmt(a.spend)}, CPM $${fmt(a.cpm)}`);
    }
    if (worst3.length > 0) {
      lines.push('', `ОБЪЯВЛЕНИЯ — СЛАБЫЕ (CTR < 2%):`);
      for (const a of worst3) {
        lines.push(`  🔴 "${a.ad_name.slice(0,45)}" — CTR ${fmt(a.ctr)}%, расход $${fmt(a.spend)}`);
      }
    }
  }

  // Daily trend (last 7 days of the period)
  if (dailyData && dailyData.length > 0) {
    const sorted = [...dailyData].sort((a,b) => a.date_start.localeCompare(b.date_start)).slice(-7);
    lines.push('', `ДНЕВНАЯ ДИНАМИКА (последние ${sorted.length} дней):`);
    for (const d of sorted) {
      lines.push(`  ${d.date_start}: расход $${fmt(d.spend)}, CTR ${fmt(d.ctr)}%, CPM $${fmt(d.cpm)}`);
    }
  }

  // Instagram
  if (igData && igData.followers_count) {
    lines.push('', `INSTAGRAM: ${igData.followers_count.toLocaleString()} подписчиков`);
  }

  return lines.join('\n');
}

// Telegram-safe HTML tags whitelist
const TG_ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote']);

// Convert markdown to Telegram-safe HTML, strip unsupported tags
function mdToHtml(text) {
  return text
    // Markdown bold
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/__(.+?)__/gs, '<b>$1</b>')
    // Markdown italic
    .replace(/\*([^*\n]+?)\*/g, '<i>$1</i>')
    .replace(/_([^_\n]+?)_/g, '<i>$1</i>')
    // Code
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    // Headers → bold
    .replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>')
    // Horizontal rules
    .replace(/^---+$/gm, '──────────────')
    // HTML tags Claude might have used that need conversion
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article)[\s>][^>]*>/gi, '\n')
    .replace(/<(h[1-6])[^>]*>(.*?)<\/h[1-6]>/gis, '<b>$2</b>')
    .replace(/<strong>(.*?)<\/strong>/gis, '<b>$1</b>')
    .replace(/<em>(.*?)<\/em>/gis, '<i>$1</i>')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/?(ul|ol|li)[^>]*>/gi, '\n')
    // Strip any remaining unsupported HTML tags
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tag) => {
      return TG_ALLOWED.has(tag.toLowerCase()) ? match : '';
    })
    // Escape stray & that aren't already HTML entities
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;')
    // Collapse excess blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Send with HTML, fallback to plain text if Telegram rejects the markup
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
  } catch (e) {
    if (e.code === 'ETELEGRAM' && e.message.includes('parse entities')) {
      // Strip all tags and retry as plain text
      const plain = text
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      return await bot.sendMessage(chatId, plain, opts);
    }
    throw e;
  }
}

// Split long messages (>3800 chars) into chunks by paragraph boundaries,
// attaching the inline keyboard only to the last chunk
async function sendLongMessage(chatId, text, keyboard = []) {
  const MAX = 3800;
  if (text.length <= MAX) {
    return safeSend(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
  // Split on double-newlines (paragraph breaks) where possible
  const paragraphs = text.split(/\n(?=\n|\n?▶️|\n?⏸|\n?✅|\n?🟡|\n?🔴|\n?📂|\n?🎨)/);
  const chunks = [];
  let cur = '';
  for (const p of paragraphs) {
    if ((cur + p).length > MAX) {
      if (cur) chunks.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur) chunks.push(cur);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await safeSend(chatId, chunks[i].trim(), isLast ? { reply_markup: { inline_keyboard: keyboard } } : {});
  }
}

async function askClaude(userMessage, data, datePreset = 'last_30d') {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const periodName = getPeriodName(datePreset);
  const summary = buildDataSummary(data);
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: `Ты — AI-аналитик и таргетолог для бренда Wallcov (декоративная штукатурка, фасадные материалы, Украина).
Ты встроен в Telegram-бот для управления рекламой. Знаешь всё о боте и его возможностях.

━━━━━━━━━━━━━━━━━━
ЧТО УМЕЕТ БОТ (отвечай если спросят):

🕘 АВТОМАТИЧЕСКИЕ ОТЧЁТЫ:
• 09:00 ежедневно — Утренний отчёт: расход вчера, охват, CTR, CPM, диалоги, подписчики Instagram + кнопки действий (пауза/бюджет)
• 13:00 и 18:00 — Проверка креативов: алерт если CTR < 1% или частота > 3 — с кнопкой выключить
• Пятница 18:00 — Недельный итог: лучшие/слабые кампании, динамика, план на следующую неделю

📊 ОТЧЁТЫ ПО ЗАПРОСУ (кнопка «Полный отчёт» или /report):
Два Word-документа с графиками, на выбранный период (7/14/30 дней, эта/прошлая неделя, прошлый месяц):
  Документ 1 — Аналитика: все цифры в таблицах + 3 графика (расход по кампаниям, CTR, дневная динамика)
  Документ 2 — Рекомендации (8 разделов):
    1. Общий результат — оценка периода, сравнение с прошлым, CTR аккаунта
    2. Анализ каждой кампании — цифры, группы объявлений, вердикт
    3. Лучшие и худшие объявления — топ-3 по CTR, что с ними делать
    4. Для таргетолога — аудитории, ставки, масштабирование
    5. Для дизайнера — форматы которые работают, идеи для новых креативов
    6. Гипотезы для тестирования — таблица с измеримыми результатами
    7. Facebook лиды — почему пустые заявки и как исправить
    8. Приоритетный план действий — что делать в первую очередь

🎛 УПРАВЛЕНИЕ (кнопки в чате):
• Поставить кампанию на паузу / увеличить бюджет +20%/+50% / снизить -20%
• Создать новую кампанию — мастер за 6 шагов

☁️ GOOGLE DRIVE: загрузка отчётов в папку по месяцам, ссылки в чат

━━━━━━━━━━━━━━━━━━
ФОРМАТ ОТВЕТА — строго Telegram HTML:
• Жирный: <b>текст</b> — используй для ключевых цифр и выводов
• Курсив: <i>текст</i> — для пояснений и уточнений
• Разделитель между блоками: ──────────
• Акцентные символы для визуального фокуса:
  🔴 критично / проблема    🟡 внимание / слабовато    ✅ хорошо / рекомендую
  📈 рост / масштаб         📉 снижение               ⚡ срочно
  💡 идея / совет           🎯 конкретное действие     📊 данные/цифры
• Структура: короткие абзацы, каждая мысль отдельно
• Длина: до 350 слов, конкретно и по делу
• Никаких markdown: не используй **, __, ##, ---, [текст](ссылка)

СТИЛЬ: разговорный, как опытный коллега. Цифры → вывод → действие.
Гипотезы — только когда уместно. Не лей воду.

КОНТЕКСТ: лиды с Facebook ранее давали пустые заявки без квалификации.
ЯЗЫК: определи по вопросу (русский или украинский).

━━━━━━━━━━━━━━━━━━
ТЕКУЩИЕ ДАННЫЕ АККАУНТА (период: ${periodName}):
${summary}`,
    messages: [{ role: 'user', content: userMessage }],
  });
  // Convert any leftover markdown just in case
  return mdToHtml(response.content[0].text);
}

// ── Voice message handling ────────────────────────────────────
async function handleVoice(chatId, voice) {
  if (!process.env.OPENAI_API_KEY) {
    await bot.sendMessage(chatId,
      '🎤 Голосовые сообщения поддерживаются, но нужен OPENAI_API_KEY в .env для транскрибации.\n\nПожалуйста, напиши вопрос текстом.'
    );
    return;
  }

  await bot.sendMessage(chatId, '🎤 Транскрибирую голосовое...');

  try {
    // Download voice file
    const fileInfo = await bot.getFile(voice.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${TG_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const arrayBuf = await response.arrayBuffer();
    const tmpPath  = resolve(__dirname, `../tmp-voice-${Date.now()}.ogg`);
    writeFileSync(tmpPath, Buffer.from(arrayBuf));

    // Transcribe via Whisper
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const { createReadStream } = await import('fs');
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-1',
    });

    try { unlinkSync(tmpPath); } catch {}

    const text = transcription.text?.trim();
    if (!text) {
      await bot.sendMessage(chatId, '⚠️ Не удалось распознать речь. Попробуй написать текстом.');
      return;
    }

    await bot.sendMessage(chatId, `📝 Распознано: "${text}"\n\n⏳ Думаю...`);

    const datePreset = detectPeriod(text);
    const periodName = getPeriodName(datePreset);
    const data = await getDataWithCache(datePreset).catch(() => null);
    const answer = await askClaude(text, data, datePreset);
    if (answer) {
      await safeSend(chatId, answer + `\n\n<i>📅 Данные за: ${periodName}</i>`);
    } else {
      await bot.sendMessage(chatId, '⚠️ Для AI-диалога добавь ANTHROPIC_API_KEY в .env файл.');
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка обработки голосового: ${e.message}`);
  }
}

// ── Campaign creation wizard ─────────────────────────────────
const OBJECTIVES = {
  engagement: { label: 'Вовлечённость (Директ)', value: 'OUTCOME_ENGAGEMENT' },
  traffic:    { label: 'Трафик', value: 'OUTCOME_TRAFFIC' },
  leads:      { label: 'Лиды', value: 'OUTCOME_LEADS' },
};

async function startWizard(chatId) {
  wizardState.set(chatId, { step: 'name', data: {} });
  await bot.sendMessage(chatId,
    `➕ <b>Создание кампании</b>\n\nШаг 1/6: Напиши <b>название</b> кампании\n<i>Пример: CBO/wide/15$ - 22.04</i>`,
    { parse_mode: 'HTML' }
  );
}

async function handleWizardMessage(chatId, text) {
  const state = wizardState.get(chatId);
  if (!state) return false;

  const { step, data } = state;

  if (step === 'name') {
    data.name = text;
    wizardState.set(chatId, { step: 'objective', data });
    await bot.sendMessage(chatId,
      `✅ Название: <b>${text}</b>\n\nШаг 2/6: Выбери <b>цель кампании</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Вовлечённость (Директ)', callback_data: 'wizard_obj_engagement' }],
            [{ text: '🚦 Трафик', callback_data: 'wizard_obj_traffic' }],
            [{ text: '🎯 Лиды', callback_data: 'wizard_obj_leads' }],
            [{ text: '❌ Отмена', callback_data: 'wizard_cancel' }],
          ]
        }
      }
    );
    return true;
  }

  if (step === 'budget') {
    const budget = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(budget) || budget <= 0) {
      await bot.sendMessage(chatId, '⚠️ Введи число, например: 10 или 15');
      return true;
    }
    data.budget = budget;
    wizardState.set(chatId, { step: 'country', data });
    await bot.sendMessage(chatId,
      `✅ Бюджет: <b>$${budget}/день</b>\n\nШаг 4/6: Напиши <b>страну</b> (код)\n<i>Примеры: UA, RU, PL, DE, US или несколько: UA,PL,DE</i>`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  if (step === 'country') {
    data.countries = text.toUpperCase().split(/[,\s]+/).filter(Boolean);
    wizardState.set(chatId, { step: 'age', data });
    await bot.sendMessage(chatId,
      `✅ Страны: <b>${data.countries.join(', ')}</b>\n\nШаг 5/6: Напиши <b>возраст</b>\n<i>Пример: 25-45</i>`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  if (step === 'age') {
    const match = text.match(/(\d+)\D+(\d+)/);
    if (!match) {
      await bot.sendMessage(chatId, '⚠️ Введи диапазон, например: 25-45');
      return true;
    }
    data.ageMin = parseInt(match[1]);
    data.ageMax = parseInt(match[2]);
    wizardState.set(chatId, { step: 'gender', data });
    await bot.sendMessage(chatId,
      `✅ Возраст: <b>${data.ageMin}–${data.ageMax}</b>\n\nШаг 6/6: Выбери <b>пол аудитории</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 Все', callback_data: 'wizard_gender_all' }],
            [{ text: '👩 Только женщины', callback_data: 'wizard_gender_women' }],
            [{ text: '👨 Только мужчины', callback_data: 'wizard_gender_men' }],
          ]
        }
      }
    );
    return true;
  }

  return false;
}

async function createCampaignFromWizard(chatId, data) {
  const objMeta = OBJECTIVES[data.objective];
  await bot.sendMessage(chatId, '⏳ Создаю кампанию...');

  const campaignRes = await metaPost(`/${AD_ACCOUNT}/campaigns`, {
    name: data.name,
    objective: objMeta.value,
    status: 'PAUSED',
    special_ad_categories: '[]',
  });

  if (campaignRes.error) throw new Error(campaignRes.error.message);

  const targeting = JSON.stringify({
    age_min: data.ageMin,
    age_max: data.ageMax,
    geo_locations: { countries: data.countries },
    ...(data.genders?.length ? { genders: data.genders } : {}),
  });

  const adsetRes = await metaPost(`/${AD_ACCOUNT}/adsets`, {
    campaign_id: campaignRes.id,
    name: `${data.name} — Адсет`,
    optimization_goal: objMeta.value === 'OUTCOME_TRAFFIC' ? 'LINK_CLICKS' : 'POST_ENGAGEMENT',
    billing_event: 'IMPRESSIONS',
    daily_budget: Math.round(data.budget * 100),
    targeting,
    status: 'PAUSED',
  });

  return { campaignId: campaignRes.id, adsetId: adsetRes.id };
}

// ── Full report helper (with period) ─────────────────────────
async function doFullReport(chatId, datePreset) {
  const label = PERIOD_LABELS[datePreset] || datePreset;
  await bot.sendMessage(chatId, `⏳ Генерирую два документа (${label})...`);
  try {
    const { analyticsPath, recsPath } = await generateBothLocal(datePreset);
    const dateStr = new Date().toLocaleDateString('ru-RU');
    await bot.sendDocument(chatId, analyticsPath, { caption: `📊 Аналитика данных — ${dateStr} (${label})` });
    await bot.sendDocument(chatId, recsPath,      { caption: `💡 Рекомендации — ${dateStr} (${label})` });
    try { unlinkSync(analyticsPath); } catch {}
    try { unlinkSync(recsPath); } catch {}
    await bot.sendMessage(chatId,
      `✅ Документы сформированы!\n\n📂 Сохранить на Google Диск:`,
      {
        reply_markup: { inline_keyboard: [
          [{ text: '☁️ Загрузить на Google Диск', callback_data: 'upload_drive' }],
          [{ text: '📊 Таблица аналитики', url: SHEET_URL }],
        ]}
      }
    );
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
  }
}

async function doUploadDrive(chatId, datePreset) {
  const label = PERIOD_LABELS[datePreset] || datePreset;
  await bot.sendMessage(chatId, `⏳ Генерирую и загружаю на Google Диск (${label})...`);
  try {
    const { analyticsLink, recsLink, folderLink } = await generateAndUpload(datePreset);
    const dateStr = new Date().toLocaleDateString('ru-RU');
    await bot.sendMessage(chatId,
      `✅ <b>Документы загружены на Google Диск</b> — ${dateStr} (${label})\n\n` +
      `📊 <a href="${analyticsLink}">Аналитика данных</a>\n` +
      `💡 <a href="${recsLink}">Рекомендации</a>\n` +
      `📂 <a href="${folderLink}">Открыть папку месяца</a>`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [
          [{ text: '📊 Таблица аналитики', url: SHEET_URL }],
        ]}
      }
    );
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка загрузки на Диск: ${e.message}`);
  }
}

// ─── Callback query handler ───────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  const msgId  = query.message.message_id;

  await bot.answerCallbackQuery(query.id);

  // ── Period selection flow ────────────────────────────────
  if (data === 'period_cancel') {
    pendingAction.delete(chatId);
    await bot.sendMessage(chatId, '❌ Отменено');
    return;
  }

  if (data in PERIOD_MAP) {
    const datePreset = PERIOD_MAP[data];
    const pending = pendingAction.get(chatId);
    pendingAction.delete(chatId);

    if (!pending) {
      await bot.sendMessage(chatId, '⚠️ Не найдено ожидающее действие. Нажми кнопку снова.');
      return;
    }

    if (pending.action === 'full_report') {
      await doFullReport(chatId, datePreset);
    } else if (pending.action === 'upload_drive') {
      await doUploadDrive(chatId, datePreset);
    }
    return;
  }

  // Full report — show period picker
  if (data === 'full_report') {
    pendingAction.set(chatId, { action: 'full_report' });
    await bot.sendMessage(chatId, '📅 Выбери период для отчёта:', { reply_markup: PERIOD_KEYBOARD });
    return;
  }

  // Upload to Drive — show period picker
  if (data === 'upload_drive') {
    pendingAction.set(chatId, { action: 'upload_drive' });
    await bot.sendMessage(chatId, '📅 Выбери период для отчёта:', { reply_markup: PERIOD_KEYBOARD });
    return;
  }

  // Pause campaign
  if (data.startsWith('pause_')) {
    const campaignId = data.replace('pause_', '');
    const res = await metaPost(`/${campaignId}`, { status: 'PAUSED' });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `⏸ Кампания поставлена на паузу ✅`);
    }
    return;
  }

  // Budget up  (format: budgetup:campaignId:pct)
  if (data.startsWith('budgetup:')) {
    const [, campaignId, pct] = data.split(':');
    const current = await metaGet(`/${campaignId}`, { fields: 'daily_budget,name' });
    const newBudget = Math.round(parseInt(current.daily_budget) * (1 + parseInt(pct)/100));
    const res = await metaPost(`/${campaignId}`, { daily_budget: newBudget });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      const oldFmt = (parseInt(current.daily_budget)/100).toFixed(0);
      const newFmt = (newBudget/100).toFixed(0);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `📈 <b>${current.name}</b>\nБюджет: $${oldFmt} → $${newFmt} (+${pct}%) ✅`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Budget down  (format: budgetdn:campaignId:pct)
  if (data.startsWith('budgetdn:')) {
    const [, campaignId, pct] = data.split(':');
    const current = await metaGet(`/${campaignId}`, { fields: 'daily_budget,name' });
    const newBudget = Math.round(parseInt(current.daily_budget) * (1 - parseInt(pct)/100));
    const res = await metaPost(`/${campaignId}`, { daily_budget: Math.max(newBudget, 100) });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      const oldFmt = (parseInt(current.daily_budget)/100).toFixed(0);
      const newFmt = (Math.max(newBudget,100)/100).toFixed(0);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `📉 <b>${current.name}</b>\nБюджет: $${oldFmt} → $${newFmt} (-${pct}%) ✅`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Disable ad  (format: disablead:adId)
  if (data.startsWith('disablead:')) {
    const adId = data.split(':')[1];
    const res = await metaPost(`/${adId}`, { status: 'PAUSED' });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `⏸ Объявление выключено ✅`);
    }
    return;
  }

  // Enable ad  (format: enablead:adId)
  if (data.startsWith('enablead:')) {
    const adId = data.split(':')[1];
    const res = await metaPost(`/${adId}`, { status: 'ACTIVE' });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `▶️ Объявление включено ✅`);
    }
    return;
  }

  // ── Adset-level controls ─────────────────────────────────────

  // Pause adset (format: pauseadset:adsetId)
  if (data.startsWith('pauseadset:')) {
    const adsetId = data.split(':')[1];
    const res = await metaPost(`/${adsetId}`, { status: 'PAUSED' });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `⏸ Группа объявлений поставлена на паузу ✅`);
    }
    return;
  }

  // Adset budget up (format: adsetup:adsetId:pct)
  if (data.startsWith('adsetup:')) {
    const [, adsetId, pct] = data.split(':');
    const current = await metaGet(`/${adsetId}`, { fields: 'daily_budget,name,campaign_id' });
    if (!current.daily_budget) {
      await bot.sendMessage(chatId, `⚠️ Бюджет задан на уровне кампании (CBO). Измени бюджет кампании — группа получит долю автоматически.`);
      return;
    }
    const newBudget = Math.round(parseInt(current.daily_budget) * (1 + parseInt(pct)/100));
    const res = await metaPost(`/${adsetId}`, { daily_budget: newBudget });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      const oldFmt = (parseInt(current.daily_budget)/100).toFixed(0);
      const newFmt = (newBudget/100).toFixed(0);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `📈 <b>${current.name}</b>\nБюджет группы: $${oldFmt} → $${newFmt} (+${pct}%) ✅`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Adset budget down (format: adsetdn:adsetId:pct)
  if (data.startsWith('adsetdn:')) {
    const [, adsetId, pct] = data.split(':');
    const current = await metaGet(`/${adsetId}`, { fields: 'daily_budget,name,campaign_id' });
    if (!current.daily_budget) {
      await bot.sendMessage(chatId, `⚠️ Бюджет задан на уровне кампании (CBO). Измени бюджет кампании.`);
      return;
    }
    const newBudget = Math.max(Math.round(parseInt(current.daily_budget) * (1 - parseInt(pct)/100)), 100);
    const res = await metaPost(`/${adsetId}`, { daily_budget: newBudget });
    if (res.error) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${res.error.message}`);
    } else {
      const oldFmt = (parseInt(current.daily_budget)/100).toFixed(0);
      const newFmt = (newBudget/100).toFixed(0);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, `📉 <b>${current.name}</b>\nБюджет группы: $${oldFmt} → $${newFmt} (-${pct}%) ✅`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Show adsets (button callback)
  if (data === 'show_adsets') {
    await sendAdsetsReport(chatId);
    return;
  }

  // Show ads (button callback)
  if (data === 'show_ads') {
    await sendAdsReport(chatId);
    return;
  }

  // Show billing (button callback)
  if (data === 'show_billing') {
    await sendBillingReport(chatId);
    return;
  }

  // Show help
  if (data === 'show_help') {
    const help = `🤖 <b>ТАРГЕТ АНАЛИТИКА — Инструкция</b>\n`
      + `━━━━━━━━━━━━━━━━━━\n\n`
      + `<b>📊 Автоматические отчёты</b>\n`
      + `<b>09:00</b> — утренний отчёт за вчера\n`
      + `<b>13:00 и 18:00</b> — проверка креативов\n`
      + `<b>Пятница 18:00</b> — недельный итог\n\n`
      + `<b>🔘 Кнопки</b>\n`
      + `• <b>⏸ Поставить на паузу</b> — останавливает кампанию\n`
      + `• <b>📈 +20% / +50%</b> — увеличивает бюджет (новая сумма видна на кнопке)\n`
      + `• <b>📉 -20%</b> — уменьшает бюджет\n`
      + `• <b>📊 Скачать отчёт</b> — два Word-документа: данные + рекомендации\n`
      + `• <b>☁️ На Диск</b> — сохраняет отчёты на Google Диск и даёт ссылку\n`
      + `• <b>➕ Новая кампания</b> — мастер создания в 6 шагов\n\n`
      + `<b>⌨️ Команды</b>\n`
      + `/report — два документа прямо сейчас\n`
      + `/status — активные кампании\n`
      + `/adsets — группы объявлений (с бюджетами и кнопками)\n`
      + `/new — создать кампанию\n`
      + `/help — эта инструкция\n\n`
      + `<b>🤖 AI-чат</b>\n`
      + `Просто напиши любой вопрос о рекламе — бот ответит как таргетолог!\n`
      + `Голосовые сообщения тоже поддерживаются (нужен OPENAI_API_KEY).\n\n`
      + `<b>📋 Инструкция в таблице (лист "🤖 Инструкция")</b>\n`
      + `<a href="${SHEET_URL}">Открыть Google Sheets</a>`;
    await bot.sendMessage(chatId, help, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Скачать отчёт', callback_data: 'full_report' }, { text: '➕ Новая кампания', callback_data: 'new_campaign' }],
          [{ text: '📋 Полная инструкция в Sheets', url: SHEET_URL }],
        ]
      }
    });
    return;
  }

  // Show status
  if (data === 'show_status') {
    const campaigns = await metaGet(`/${AD_ACCOUNT}/campaigns`, {
      fields: 'id,name,status,daily_budget,start_time',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: 20,
    });
    const active = campaigns.data || [];
    let msg2 = `📈 <b>Активные кампании (${active.length})</b>\n\n`;
    for (const c of active) {
      const b = c.daily_budget ? `$${(parseInt(c.daily_budget)/100).toFixed(0)}/д` : 'без бюджета';
      const days = c.start_time ? Math.floor((Date.now() - new Date(c.start_time)) / 86400000) : '?';
      const tag = days < 7 ? ` 🔄 обучение (${days}д)` : '';
      msg2 += `• <b>${c.name}</b> — ${b}${tag}\n`;
    }
    msg2 += `\n<i>🔄 обучение — не трогать первые 7 дней</i>`;
    await bot.sendMessage(chatId, msg2, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📊 Полный отчёт', callback_data: 'full_report' }, { text: '➕ Новая кампания', callback_data: 'new_campaign' }],
      ]}
    });
    return;
  }

  // New campaign wizard
  if (data === 'new_campaign') {
    await startWizard(chatId);
    return;
  }

  // Wizard: objective
  if (data.startsWith('wizard_obj_')) {
    const state = wizardState.get(chatId);
    if (!state) return;
    const obj = data.replace('wizard_obj_', '');
    state.data.objective = obj;
    wizardState.set(chatId, { step: 'budget', data: state.data });
    await bot.sendMessage(chatId,
      `✅ Цель: <b>${OBJECTIVES[obj].label}</b>\n\nШаг 3/6: Укажи <b>дневной бюджет</b> в долларах\n<i>Пример: 10</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Wizard: gender
  if (data.startsWith('wizard_gender_')) {
    const state = wizardState.get(chatId);
    if (!state) return;
    const gender = data.replace('wizard_gender_', '');
    state.data.genders = gender === 'women' ? [2] : gender === 'men' ? [1] : [];

    const d   = state.data;
    const obj = OBJECTIVES[d.objective];
    let summary = `📋 <b>Подтвердите создание кампании:</b>\n\n`;
    summary += `📌 Название: ${d.name}\n`;
    summary += `🎯 Цель: ${obj.label}\n`;
    summary += `💰 Бюджет: $${d.budget}/день\n`;
    summary += `🌍 Страны: ${d.countries.join(', ')}\n`;
    summary += `👤 Возраст: ${d.ageMin}–${d.ageMax}\n`;
    summary += `👥 Пол: ${gender === 'all' ? 'Все' : gender === 'women' ? 'Женщины' : 'Мужчины'}\n`;
    summary += `\n<i>Кампания будет создана на паузе. Вы включите её вручную.</i>`;

    wizardState.set(chatId, { step: 'confirm', data: state.data });
    await bot.sendMessage(chatId, summary, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Создать', callback_data: 'wizard_confirm' },
           { text: '❌ Отмена', callback_data: 'wizard_cancel' }],
        ]
      }
    });
    return;
  }

  // Wizard: confirm
  if (data === 'wizard_confirm') {
    const state = wizardState.get(chatId);
    if (!state) return;
    try {
      const result = await createCampaignFromWizard(chatId, state.data);
      wizardState.delete(chatId);
      await bot.sendMessage(chatId,
        `✅ <b>Кампания создана!</b>\n\nID кампании: <code>${result.campaignId}</code>\nID адсета: <code>${result.adsetId}</code>\n\n<i>Статус: PAUSED — включите вручную после добавления объявления.</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      wizardState.delete(chatId);
      await bot.sendMessage(chatId, `❌ Ошибка при создании: ${e.message}`);
    }
    return;
  }

  // Wizard: cancel
  if (data === 'wizard_cancel') {
    wizardState.delete(chatId);
    await bot.sendMessage(chatId, '❌ Создание отменено');
    return;
  }
});

// ─── Startup / Help message ───────────────────────────────────
function buildStartText() {
  return (
    `🤖 <b>ТАРГЕТ АНАЛИТИКА — бот активен</b>\n`
  + `━━━━━━━━━━━━━━━━━━━━━━\n\n`

  + `<b>🔄 АВТОМАТИКА — что приходит само</b>\n`
  + `<b>09:00</b> — Утренний отчёт за вчера: расход, охват, CTR, CPM, диалоги, подписчики. Сразу с кнопками действий — поставить на паузу, увеличить/снизить бюджет.\n`
  + `<b>13:00 и 18:00</b> — Проверка всех объявлений. Если CTR &lt; 1% или частота &gt; 3 — получишь алерт с кнопкой «Выключить».\n`
  + `<b>Пятница 18:00</b> — Недельный итог: лучшие и слабые кампании, динамика vs прошлая неделя, план действий на следующую.\n\n`

  + `<b>📊 ОТЧЁТЫ — два Word-документа с графиками</b>\n`
  + `Нажми <b>«📊 Полный отчёт»</b> → выбери период → получишь два документа:\n`
  + `• <b>Аналитика</b> — все цифры в таблицах + 3 графика (расход по кампаниям, CTR, дневная динамика)\n`
  + `• <b>Рекомендации</b> — детальный разбор в 8 разделах:\n`
  + `  1. Общий результат периода\n`
  + `  2. Анализ каждой кампании и её групп объявлений\n`
  + `  3. Лучшие и худшие объявления\n`
  + `  4. Рекомендации для таргетолога\n`
  + `  5. Рекомендации для дизайнера/контент-мейкера\n`
  + `  6. Гипотезы для тестирования\n`
  + `  7. Анализ Facebook лидов + решения\n`
  + `  8. Приоритетный план действий\n\n`
  + `Периоды: 7 дней / 14 дней / 30 дней / эта неделя / прошлая неделя / прошлый месяц\n\n`

  + `<b>☁️ GOOGLE DRIVE</b>\n`
  + `Кнопка <b>«☁️ На Google Диск»</b> → выбери период → документы загрузятся и ты получишь прямые ссылки.\n`
  + `Структура: Статистика таргета / Отчёты / Апрель 2026 / дата-аналитика.docx + дата-рекомендации.docx\n\n`

  + `<b>🎛 УПРАВЛЕНИЕ КАМПАНИЯМИ</b>\n`
  + `Кнопки появляются прямо в утреннем отчёте:\n`
  + `• <b>⏸ На паузу / 📈+20% / 📉-20%</b> — управление бюджетом кампании\n`
  + `• <b>📂 Группы</b> — все адсеты с CTR, бюджетами, кнопками паузы и масштаба\n`
  + `• <b>🎨 Объявления</b> — все объявления, включить/выключить каждое\n`
  + `• <b>📈 Кампании</b> — статус, бюджет, дни обучения\n\n`

  + `<b>➕ СОЗДАТЬ КАМПАНИЮ — мастер за 6 шагов</b>\n`
  + `Нажми <b>«➕ Новая кампания»</b> и бот по шагам спросит:\n`
  + `1. Название\n`
  + `2. Цель (Вовлечённость/Трафик/Лиды)\n`
  + `3. Дневной бюджет в $\n`
  + `4. Страны (UA, PL, DE...)\n`
  + `5. Возраст (пример: 25-55)\n`
  + `6. Пол → подтверждение → кампания создана на паузе\n\n`

  + `<b>🤖 AI-ЧАТ — таргетолог-аналитик в кармане</b>\n`
  + `Напиши любой вопрос — бот знает твои текущие данные и отвечает конкретно.\n\n`
  + `Примеры вопросов:\n`
  + `• "Почему у кампании X упал CTR?"\n`
  + `• "Что делать с частотой 3.5?"\n`
  + `• "Стоит ли масштабировать этот адсет?"\n`
  + `• "Какие креативы сейчас работают лучше всего?"\n`
  + `• "Почему Facebook лиды не конвертируются в продажи?"\n`
  + `• "Предложи гипотезы для теста новой аудитории"\n\n`
  + `Голосовые сообщения тоже работают — говори вопрос, бот транскрибирует и ответит.\n\n`

  + `<b>🧠 КАК ЧИТАТЬ МЕТРИКИ</b>\n`
  + `CTR (% кликов из показов):\n`
  + `• &lt; 1% 🔴 — плохо, выключать или менять креатив\n`
  + `• 1–2% 🟡 — слабо, нужна оптимизация\n`
  + `• &gt; 2% ✅ — хорошо, можно масштабировать\n\n`
  + `CPM (цена 1000 показов):\n`
  + `• &lt; $5 — дёшево, хорошая аудитория\n`
  + `• $5–15 — норма\n`
  + `• &gt; $15 — дорого, проверь аудиторию\n\n`
  + `Частота (сколько раз видит один человек):\n`
  + `• &lt; 2 — норма\n`
  + `• 2–3 🟡 — скоро выгорит, готовь новые креативы\n`
  + `• &gt; 3 🔴 — аудитория выгорела, меняй таргетинг\n\n`
  + `🔄 Обучение — первые 7 дней после запуска не трогай кампанию.\n\n`

  + `<b>⌨️ КОМАНДЫ</b>\n`
  + `/report — полный отчёт (выбор периода)\n`
  + `/status — активные кампании с бюджетами\n`
  + `/adsets — группы объявлений (бюджет, CTR, пауза, масштаб)\n`
  + `/ads — объявления (CTR, расход, включить/выключить)\n`
  + `/new — создать кампанию\n`
  + `/help — эта инструкция\n\n`

  + `<a href="${SHEET_URL}">📊 Открыть таблицу аналитики в Google Sheets</a>`
  );
}

function buildStartKeyboard() {
  return [
    [
      { text: '📊 Полный отчёт (Word)', callback_data: 'full_report' },
      { text: '☁️ На Google Диск',     callback_data: 'upload_drive' },
    ],
    [
      { text: '📈 Кампании',   callback_data: 'show_status' },
      { text: '📂 Группы',     callback_data: 'show_adsets' },
      { text: '🎨 Объявления', callback_data: 'show_ads' },
    ],
    [
      { text: '💳 Биллинг',        callback_data: 'show_billing' },
      { text: '➕ Новая кампания', callback_data: 'new_campaign' },
      { text: '📊 Таблица',        url: SHEET_URL },
    ],
  ];
}

async function sendStartMessage(chatId) {
  await bot.sendMessage(chatId, buildStartText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buildStartKeyboard() },
  });
}

// ─── Message handler ──────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text || '';
  try {

  // Voice message
  if (msg.voice) {
    await handleVoice(chatId, msg.voice);
    return;
  }

  if (text.startsWith('/')) {
    // Commands
    if (text === '/report' || text === '/отчет') {
      // Show period picker for /report command too
      pendingAction.set(chatId, { action: 'full_report' });
      await bot.sendMessage(chatId, '📅 Выбери период для отчёта:', { reply_markup: PERIOD_KEYBOARD });
      return;
    }

    if (text === '/start' || text === '/старт') {
      await sendStartMessage(chatId);
      return;
    }

    if (text === '/new' || text === '/создать') {
      await startWizard(chatId);
      return;
    }

    if (text === '/status') {
      const campaigns = await metaGet(`/${AD_ACCOUNT}/campaigns`, {
        fields: 'id,name,status,daily_budget,start_time',
        effective_status: JSON.stringify(['ACTIVE']),
        limit: 20,
      });
      const active = campaigns.data || [];
      let msg2 = `📈 <b>Активные кампании (${active.length})</b>\n\n`;
      for (const c of active) {
        const b = c.daily_budget ? `$${(parseInt(c.daily_budget)/100).toFixed(0)}/д` : 'без бюджета';
        const days = c.start_time ? Math.floor((Date.now() - new Date(c.start_time)) / 86400000) : '?';
        const tag = days < 7 ? ` 🔄 обучение (${days}д)` : '';
        msg2 += `• <b>${c.name}</b> — ${b}${tag}\n`;
      }
      msg2 += `\n<i>🔄 обучение — не трогать первые 7 дней</i>`;
      await bot.sendMessage(chatId, msg2, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '📊 Полный отчёт', callback_data: 'full_report' }, { text: '➕ Новая кампания', callback_data: 'new_campaign' }],
        ]}
      });
      return;
    }

    if (text === '/help' || text === '/инструкция') {
      await sendStartMessage(chatId);
      return;
    }

    // /adsets — show all adsets with budget controls
    if (text === '/adsets' || text === '/группы') {
      await sendAdsetsReport(chatId);
      return;
    }

    // /ads — show all ads with on/off controls
    if (text === '/ads' || text === '/объявления') {
      await sendAdsReport(chatId);
      return;
    }

    // /billing — billing status + top-up link
    if (text === '/billing' || text === '/биллинг') {
      await sendBillingReport(chatId);
      return;
    }

    // /myid — show personal chat ID (to configure personal notifications)
    if (text === '/myid') {
      await safeSend(chatId,
        `🆔 Твой личный Chat ID: <code>${chatId}</code>\n\n`
        + `Добавь его в .env на сервере:\n`
        + `<code>TELEGRAM_PERSONAL_CHAT_ID=${chatId}</code>\n\n`
        + `После этого критичные уведомления будут приходить в личку.`
      );
      return;
    }

    return;
  }

  // Wizard text input — check first
  if (wizardState.has(chatId)) {
    const handled = await handleWizardMessage(chatId, text);
    if (handled) return;
  }

  // AI chat — any non-command, non-wizard text message
  if (text.trim()) {
    if (!process.env.ANTHROPIC_API_KEY) {
      await bot.sendMessage(chatId,
        '🤖 Для AI-диалога нужно добавить ANTHROPIC_API_KEY в .env файл.\n\nПока можешь использовать кнопки для управления рекламой.'
      );
      return;
    }

    // Show typing indicator
    await bot.sendChatAction(chatId, 'typing');

    try {
      const datePreset  = detectPeriod(text);
      const periodName  = getPeriodName(datePreset);
      const data = await getDataWithCache(datePreset).catch(() => null);
      const answer = await askClaude(text, data, datePreset);
      if (answer) {
        // Append period hint if non-default
        const hint = datePreset !== 'last_30d'
          ? `\n\n<i>📅 Данные за: ${periodName}</i>`
          : `\n\n<i>📅 Данные за: ${periodName}</i>`;
        await safeSend(chatId, answer + hint);
      } else {
        await bot.sendMessage(chatId, '⚠️ Не удалось получить ответ от AI. Попробуй позже.');
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Ошибка AI-чата: ${e.message}`);
    }
    return;
  }

  } catch (e) {
    console.error('Message handler error:', e.message);
    try { await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); } catch {}
  }
});

// ─── Adsets report ───────────────────────────────────────────
async function sendAdsetsReport(chatId) {
  try {
    await bot.sendMessage(chatId, '⏳ Загружаю группы объявлений...');

    const [campsRes, adsetsRes, insRes] = await Promise.all([
      metaGet(`/${AD_ACCOUNT}/campaigns`, { fields: 'id,name,status,daily_budget', limit: 50 }),
      metaGet(`/${AD_ACCOUNT}/adsets`,    { fields: 'id,name,status,daily_budget,campaign_id', limit: 100 }),
      metaGet(`/${AD_ACCOUNT}/insights`,  {
        fields: 'adset_id,adset_name,spend,ctr,frequency,impressions',
        level: 'adset', date_preset: 'last_7d', limit: 200,
      }),
    ]);

    const campMap = {};
    for (const c of (campsRes.data || [])) campMap[c.id] = c;
    const insMap = {};
    for (const r of (insRes.data || [])) insMap[r.adset_id] = r;

    const adsets = (adsetsRes.data || []).filter(a => a.status === 'ACTIVE');
    if (!adsets.length) {
      await bot.sendMessage(chatId, '📭 Нет активных групп объявлений');
      return;
    }

    const byCamp = {};
    for (const a of adsets) {
      if (!byCamp[a.campaign_id]) byCamp[a.campaign_id] = [];
      byCamp[a.campaign_id].push(a);
    }

    let msg = `📂 <b>Группы объявлений</b>\n<i>Статистика за 7 дней</i>\n──────────────\n`;
    const keyboard = [];

    for (const [campId, campAdsets] of Object.entries(byCamp)) {
      const camp       = campMap[campId] || {};
      const campEm     = camp.status === 'ACTIVE' ? '▶️' : '⏸';
      const campBudget = camp.daily_budget ? ` $${(parseInt(camp.daily_budget)/100).toFixed(0)}/д` : '';
      msg += `\n${campEm} <b>${camp.name || campId}</b>${campBudget}\n`;

      const sorted = [...campAdsets].sort((a, b) =>
        parseFloat((insMap[b.id]||{}).ctr||0) - parseFloat((insMap[a.id]||{}).ctr||0));

      for (const a of sorted) {
        const ins    = insMap[a.id] || {};
        const ctr    = parseFloat(ins.ctr    || 0);
        const spend  = parseFloat(ins.spend  || 0);
        const freq   = parseFloat(ins.frequency || 0);
        const budget = a.daily_budget ? `$${(parseInt(a.daily_budget)/100).toFixed(0)}/д` : 'CBO';
        const em     = ctr >= 2 ? '✅' : ctr >= 1 ? '🟡' : spend > 0 ? '🔴' : '⚫';
        msg += `  ${em} <b>${a.name}</b>\n`;
        msg += `     ${budget} | CTR ${fmt(ctr)}% | $${fmt(spend)} | Частота ${fmt(freq)}${freq > 3 ? ' ⚡' : ''}\n`;

        const row = [{ text: `⏸ ${a.name.slice(0,22)}`, callback_data: `pauseadset:${a.id}` }];
        if (a.daily_budget) {
          row.push({ text: `📈 +20%`, callback_data: `adsetup:${a.id}:20` });
          row.push({ text: `📉 -20%`, callback_data: `adsetdn:${a.id}:20` });
        } else if (camp.daily_budget) {
          row.push({ text: `📈 Кампания +20%`, callback_data: `budgetup:${campId}:20` });
        }
        keyboard.push(row);
      }
    }
    msg += `\n<i>💡 CBO — бюджет кампании. +/-20% изменяет бюджет кампании.</i>`;

    await sendLongMessage(chatId, msg, keyboard);
  } catch (e) {
    console.error('sendAdsetsReport error:', e.message);
    await bot.sendMessage(chatId, `❌ Ошибка загрузки групп: ${e.message}`);
  }
}

// ─── Ads (individual) report ─────────────────────────────────
async function sendAdsReport(chatId) {
  try {
    await bot.sendMessage(chatId, '⏳ Загружаю объявления...');

    const [adsRes, insRes] = await Promise.all([
      metaGet(`/${AD_ACCOUNT}/ads`, {
        fields: 'id,name,status,adset_id,campaign_id',
        limit: 100,
      }),
      metaGet(`/${AD_ACCOUNT}/insights`, {
        fields: 'ad_id,ad_name,campaign_name,adset_name,spend,ctr,impressions,cpm,frequency,actions',
        level: 'ad', date_preset: 'last_7d', limit: 200,
      }),
    ]);

    const insMap = {};
    for (const r of (insRes.data || [])) insMap[r.ad_id] = r;

    const ads = (adsRes.data || []).filter(a => a.status === 'ACTIVE' || a.status === 'PAUSED');
    if (!ads.length) {
      await bot.sendMessage(chatId, '📭 Нет объявлений');
      return;
    }

    // Sort: active first, then by CTR
    const sorted = [...ads].sort((a, b) => {
      if (b.status !== a.status) return a.status === 'ACTIVE' ? -1 : 1;
      return parseFloat((insMap[b.id]||{}).ctr||0) - parseFloat((insMap[a.id]||{}).ctr||0);
    });

    // Group by campaign
    const byCamp = {};
    for (const a of sorted) {
      const campName = (insMap[a.id] || {}).campaign_name || a.campaign_id;
      if (!byCamp[campName]) byCamp[campName] = [];
      byCamp[campName].push(a);
    }

    let msg = `🎨 <b>Объявления</b>\n<i>Статистика за 7 дней</i>\n──────────────\n`;
    const keyboard = [];
    let shown = 0;

    for (const [campName, campAds] of Object.entries(byCamp)) {
      msg += `\n<b>${campName}:</b>\n`;
      for (const a of campAds) {
        if (shown >= 20) break;
        const ins   = insMap[a.id] || {};
        const ctr   = parseFloat(ins.ctr   || 0);
        const spend = parseFloat(ins.spend || 0);
        const freq  = parseFloat(ins.frequency || 0);
        const cpm   = parseFloat(ins.cpm   || 0);
        const acts  = parseActions(ins.actions);
        const res   = (acts['onsite_conversion.messaging_conversation_started_7d']||0) + (acts['lead']||0);
        const isOn  = a.status === 'ACTIVE';
        const em    = isOn ? (ctr >= 2 ? '✅' : ctr >= 1 ? '🟡' : spend > 0 ? '🔴' : '▶️') : '⏸';

        msg += `  ${em} <b>${a.name.slice(0,40)}</b>\n`;
        if (spend > 0 || ctr > 0) {
          msg += `     CTR ${fmt(ctr)}% | $${fmt(spend)} | CPM $${fmt(cpm)}${freq > 3 ? ` ⚡${fmt(freq)}` : ''}\n`;
          if (res > 0) msg += `     🎯 Результатов: ${res}\n`;
        } else {
          msg += `     Нет расхода за 7 дней\n`;
        }

        if (isOn) {
          keyboard.push([{ text: `⏸ Выкл: ${a.name.slice(0,24)}`, callback_data: `disablead:${a.id}` }]);
        } else {
          keyboard.push([{ text: `▶️ Вкл: ${a.name.slice(0,24)}`, callback_data: `enablead:${a.id}` }]);
        }
        shown++;
      }
    }
    if (ads.length > 20) msg += `\n<i>Первые 20 из ${ads.length}</i>`;

    await sendLongMessage(chatId, msg, keyboard);
  } catch (e) {
    console.error('sendAdsReport error:', e.message);
    await bot.sendMessage(chatId, `❌ Ошибка загрузки объявлений: ${e.message}`);
  }
}

// ─── Scheduler ────────────────────────────────────────────────
// Fires fn at hh:mm every day, then reschedules itself
function scheduleDaily(hour, minute, fn, label) {
  function fireNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    console.log(`⏰ [${label}] наследующий запуск через ${Math.round(delay / 60000)} мин`);
    setTimeout(async () => {
      console.log(`🔔 [${label}] запуск ${new Date().toLocaleTimeString('ru-RU')}`);
      try { await fn(); } catch (e) { console.error(`❌ [${label}] ошибка:`, e.message); }
      fireNext();
    }, delay);
  }
  fireNext();
}

// ── 09:00 Morning report ──────────────────────────────────────
async function sendMorningReport() {
  const insightFields = 'spend,impressions,clicks,reach,cpm,ctr,actions,frequency';
  const campFields    = 'campaign_id,campaign_name,spend,impressions,clicks,reach,cpm,ctr,actions,frequency';

  const yesterday = new Date(Date.now() - 86400000);
  const ySince = yesterday.toISOString().split('T')[0];
  const yUntil = new Date().toISOString().split('T')[0]; // "until" is exclusive — gives yesterday's data

  const [overview, campaignsRaw, campInsights, igData, igInsights, billing] = await Promise.all([
    metaGet(`/${AD_ACCOUNT}/insights`, { fields: insightFields, date_preset: 'yesterday' }),
    metaGet(`/${AD_ACCOUNT}/campaigns`, { fields: 'id,name,status,daily_budget,objective', limit: 50 }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: campFields, level: 'campaign', date_preset: 'yesterday', limit: 50,
    }),
    metaGet(`/${IG_ID}`, { fields: 'followers_count' }).catch(() => ({})),
    metaGet(`/${IG_ID}/insights`, {
      metric: 'follower_count', period: 'day', since: ySince, until: yUntil,
    }).catch(() => ({})),
    metaGet(`/${AD_ACCOUNT}`, {
      fields: 'balance,amount_spent,spend_cap,account_status,currency,funding_source_details',
    }).catch(() => null),
  ]);

  // Extract yesterday's net follower change from IG Insights
  const igDailyValues = igInsights.data?.[0]?.values || [];
  const igYesterdayEntry = igDailyValues.find(v => {
    if (!v.end_time) return false;
    const d = new Date(v.end_time);
    return d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth();
  });
  const igFollowers = igYesterdayEntry?.value; // undefined if no data

  const ov   = overview.data?.[0] || {};
  const acts = parseActions(ov.actions);
  const messages = acts['onsite_conversion.messaging_conversation_started_7d'] || 0;
  const leads    = acts['lead'] || 0;

  const spend = parseFloat(ov.spend || 0);
  const reach = parseInt(ov.reach || 0);
  const ctr   = parseFloat(ov.ctr || 0);
  const cpm   = parseFloat(ov.cpm || 0);
  const freq  = parseFloat(ov.frequency || 0);

  const yDate = yesterday.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  const ctrEmoji = ctr >= 3 ? '✅' : ctr >= 1.5 ? '🟡' : '🔴';
  const freqNote = freq > 3 ? ` ⚡ частота ${fmt(freq)}` : '';

  let msg = `☀️ <b>Утренний отчёт</b>\n<i>${yDate}</i>\n──────────────\n\n`;
  msg += `💰 Расход: <b>$${fmt(spend)}</b>\n`;
  msg += `👥 Охват: <b>${reach.toLocaleString('ru-RU')}</b>\n`;
  msg += `${ctrEmoji} CTR: <b>${fmt(ctr)}%</b>${freqNote}\n`;
  msg += `📊 CPM: <b>$${fmt(cpm)}</b>\n`;
  if (messages > 0) msg += `💬 Диалоги: <b>${messages}</b>\n`;
  if (leads > 0)    msg += `📋 Лиды: <b>${leads}</b>\n`;
  if (igData.followers_count) {
    msg += `📸 Instagram: <b>${igData.followers_count.toLocaleString('ru-RU')}</b> подписчиков\n`;
  }

  // Billing status
  if (billing) {
    const bStatus = billing.account_status ?? 1;
    const bInfo   = BILLING_STATUS[bStatus] || { ok: true, emoji: '✅', label: 'Активен' };
    const bBal    = parseInt(billing.balance || 0) / 100;
    const bSpent  = parseInt(billing.amount_spent || 0) / 100;
    const bCap    = parseInt(billing.spend_cap || 0) / 100;
    const bCard   = billing.funding_source_details?.display_string || '';

    if (!bInfo.ok) {
      // Critical — will also trigger sendCritical via checkBilling, but show inline too
      msg += `\n${bInfo.emoji} <b>Биллинг: ${bInfo.label}!</b> Проверь кабинет.\n`;
    } else {
      msg += `\n💳 Биллинг: ${bInfo.emoji} ${bInfo.label}`;
      if (bCard) msg += ` · ${bCard}`;
      if (bBal > 0) msg += ` · баланс $${fmt(bBal)}`;
      if (bCap > 0) msg += ` · лимит $${fmt(bCap - bSpent)} осталось`;
      msg += '\n';
    }

    // Fire critical alert asynchronously if needed
    if (!bInfo.ok) {
      const alertMsg = `🚨 <b>Биллинг Meta: ${bInfo.emoji} ${bInfo.label.toUpperCase()}</b>\n\n`
        + `Рекламный кабинет может быть заблокирован!\n`
        + (bCard ? `Карта: <b>${bCard}</b>\n` : '')
        + `Потрачено всего: <b>$${fmt(bSpent)}</b>`;
      sendCritical(alertMsg, [[
        { text: '💳 Биллинг Meta', url: BILLING_URL },
        { text: '➕ Пополнить', url: ADD_FUNDS_URL },
      ]]).catch(() => {});
    }
  }

  const insightMap = {};
  for (const r of campInsights.data || []) insightMap[r.campaign_id] = r;

  const activeCamps = (campaignsRaw.data || []).filter(c => c.status === 'ACTIVE');

  if (activeCamps.length > 0) {
    msg += `\n<b>📋 Активные кампании:</b>\n`;
    for (const c of activeCamps) {
      const ci    = insightMap[c.id] || {};
      const cSpend = parseFloat(ci.spend || 0);
      const cCtr   = parseFloat(ci.ctr || 0);
      const budget = c.daily_budget ? `$${(parseInt(c.daily_budget) / 100).toFixed(0)}/д` : '';
      const em     = cCtr >= 2 ? '✅' : cCtr >= 1 ? '🟡' : cSpend > 0 ? '🔴' : '⚫';
      msg += `${em} <b>${c.name}</b>\n   $${fmt(cSpend)} расход | CTR ${fmt(cCtr)}% | ${budget}\n`;
    }
  }

  if (spend === 0) msg += `\n🔴 <b>Расход $0.00 — проверь кабинет!</b>`;

  // Action buttons per campaign (max 4)
  const keyboard = [];
  for (const c of activeCamps.slice(0, 4)) {
    keyboard.push([
      { text: `⏸ ${c.name.slice(0, 18)}`, callback_data: `pause_${c.id}` },
      { text: `📈 +20%`, callback_data: `budgetup:${c.id}:20` },
      { text: `📉 -20%`, callback_data: `budgetdn:${c.id}:20` },
    ]);
  }
  keyboard.push([
    { text: '📊 Полный отчёт', callback_data: 'full_report' },
    { text: '📋 Статус',       callback_data: 'status' },
  ]);

  await bot.sendMessage(TG_CHAT, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  console.log('✅ Morning report sent');

  // Save yesterday's data to monthly Google Sheet (async, non-blocking)
  // igFollowers = net daily follower change; undefined when API has no data → row 37 skipped
  saveDailyToSheet(yesterday, campInsights.data || [], campaignsRaw.data || [], igFollowers).catch(e => {
    console.warn('⚠️ saveDailyToSheet error:', e.message);
  });
}

// ── 13:00 / 18:00 Дневной отчёт по эффективности ─────────────
async function sendDayCheck() {
  const campFields  = 'campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,actions,frequency,reach';
  const adsetFields = 'adset_id,adset_name,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,frequency,actions';
  const adFields    = 'ad_id,ad_name,campaign_name,adset_name,spend,impressions,clicks,cpm,ctr,frequency,actions';

  const [campsRaw, campIns, adsetIns, adIns] = await Promise.all([
    metaGet(`/${AD_ACCOUNT}/campaigns`, { fields: 'id,name,status,daily_budget', limit: 50 }),
    metaGet(`/${AD_ACCOUNT}/insights`, { fields: campFields,  level: 'campaign', date_preset: 'last_7d', limit: 50 }),
    metaGet(`/${AD_ACCOUNT}/insights`, { fields: adsetFields, level: 'adset',    date_preset: 'last_7d', limit: 100 }),
    metaGet(`/${AD_ACCOUNT}/insights`, { fields: adFields,    level: 'ad',       date_preset: 'last_7d', limit: 100 }),
  ]);

  const hour      = new Date().getHours();
  const timeLabel = hour < 16 ? '13:00' : '18:00';
  const today     = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  const activeCamps = (campsRaw.data || []).filter(c => c.status === 'ACTIVE');
  const campInsMap  = {};
  for (const r of campIns.data || []) campInsMap[r.campaign_id] = r;

  // ── Блок 1: Кампании ──
  let msg = `📊 <b>Отчёт ${timeLabel} — ${today}</b>\n──────────────\n\n`;
  msg += `<b>🎯 КАМПАНИИ (7 дней)</b>\n`;

  let totalSpend = 0;
  for (const c of activeCamps) {
    const ci    = campInsMap[c.id] || {};
    const spend = parseFloat(ci.spend || 0);
    const ctr   = parseFloat(ci.ctr || 0);
    const cpm   = parseFloat(ci.cpm || 0);
    const freq  = parseFloat(ci.frequency || 0);
    const budget = c.daily_budget ? `$${(parseInt(c.daily_budget)/100).toFixed(0)}/д` : '—';
    const acts  = parseActions(ci.actions);
    const msgs  = acts['onsite_conversion.messaging_conversation_started_7d'] || 0;
    const leads = acts['lead'] || 0;
    const em    = ctr >= 2 ? '✅' : ctr >= 1 ? '🟡' : spend > 0 ? '🔴' : '⚫';
    totalSpend += spend;
    msg += `\n${em} <b>${c.name}</b>\n`;
    msg += `   💰 $${fmt(spend)} | CTR ${fmt(ctr)}% | CPM $${fmt(cpm)} | Частота ${fmt(freq)} | ${budget}\n`;
    if (msgs)  msg += `   💬 Диалогов: ${msgs}\n`;
    if (leads) msg += `   📋 Лидов: ${leads}\n`;
  }
  msg += `\n<b>Итого расход за 7 дней: $${fmt(totalSpend)}</b>\n`;

  // ── Блок 2: Адсеты (сгруппированы по кампаниям) ──
  const adsetsByCamp = {};
  for (const a of adsetIns.data || []) {
    if (!adsetsByCamp[a.campaign_name]) adsetsByCamp[a.campaign_name] = [];
    adsetsByCamp[a.campaign_name].push(a);
  }

  msg += `\n──────────────\n<b>📂 ГРУППЫ ОБЪЯВЛЕНИЙ</b>\n`;
  for (const [campName, adsets] of Object.entries(adsetsByCamp)) {
    const sorted = adsets.sort((a, b) => parseFloat(b.ctr || 0) - parseFloat(a.ctr || 0));
    msg += `\n<i>${campName}:</i>\n`;
    for (const a of sorted.slice(0, 4)) {
      const ctr  = parseFloat(a.ctr || 0);
      const freq = parseFloat(a.frequency || 0);
      const em   = ctr >= 2 ? '✅' : ctr >= 1 ? '🟡' : '🔴';
      const freqWarn = freq > 3 ? ` ⚡${fmt(freq)}` : '';
      msg += `  ${em} ${a.adset_name} — CTR ${fmt(ctr)}% | $${fmt(parseFloat(a.spend || 0))}${freqWarn}\n`;
    }
  }

  // ── Блок 3: Объявления — лучшие + слабые ──
  const adsWithSpend = (adIns.data || []).filter(a => parseFloat(a.spend || 0) > 0.5);
  const sortedAds    = [...adsWithSpend].sort((a, b) => parseFloat(b.ctr || 0) - parseFloat(a.ctr || 0));
  const bestAds      = sortedAds.slice(0, 3);
  const weakAds      = sortedAds.filter(a => parseFloat(a.ctr || 0) < 1.0 || parseFloat(a.frequency || 0) > 3.0);

  msg += `\n──────────────\n<b>🎨 ОБЪЯВЛЕНИЯ</b>\n`;

  if (bestAds.length > 0) {
    msg += `\n🏆 <b>Лучшие по CTR:</b>\n`;
    for (const a of bestAds) {
      msg += `  ✅ ${a.ad_name} — CTR ${fmt(parseFloat(a.ctr || 0))}% | $${fmt(parseFloat(a.spend || 0))}\n`;
    }
  }

  // ── Блок 4: Вывод и рекомендации ──
  const keyboard = [];
  msg += `\n──────────────\n`;

  if (weakAds.length > 0) {
    // Есть проблемы — детальные рекомендации
    msg += `⚠️ <b>Слабые (CTR &lt; 1% или частота &gt; 3):</b>\n`;
    for (const a of weakAds.slice(0, 5)) {
      const ctr  = parseFloat(a.ctr || 0);
      const freq = parseFloat(a.frequency || 0);
      const warn = [];
      if (ctr  < 1.0) warn.push(`CTR ${fmt(ctr)}% 🔴`);
      if (freq > 3.0) warn.push(`Частота ${fmt(freq)} ⚡`);
      msg += `  🔴 ${a.ad_name} — ${warn.join(' | ')} | $${fmt(parseFloat(a.spend || 0))}\n`;
      keyboard.push([{ text: `⏸ Выключить: ${a.ad_name.slice(0, 24)}`, callback_data: `disablead:${a.ad_id}` }]);
    }
    msg += `\n🎯 <b>Рекомендация:</b> выключи слабые объявления — бюджет автоматически перераспределится на рабочие креативы. Это ускорит оптимизацию и снизит CPM.\n`;
  } else {
    // Всё в норме — краткий позитивный вывод с пояснением
    const avgCtr = adsWithSpend.length
      ? adsWithSpend.reduce((s, a) => s + parseFloat(a.ctr || 0), 0) / adsWithSpend.length
      : 0;
    const avgFreq = adsWithSpend.length
      ? adsWithSpend.reduce((s, a) => s + parseFloat(a.frequency || 0), 0) / adsWithSpend.length
      : 0;

    msg += `✅ <b>Проблем нет</b>\n`;
    msg += `Средний CTR по объявлениям: <b>${fmt(avgCtr)}%</b> — выше порога 1%.\n`;
    msg += `Средняя частота: <b>${fmt(avgFreq)}</b> — аудитория не перегрета.\n`;
    msg += `\n<i>💡 Алгоритм Meta продолжает оптимизацию: чем дольше работают объявления без изменений — тем точнее находит аудиторию. Не вмешивайся без причины.</i>\n`;
  }

  keyboard.push([{ text: '📊 Полный отчёт', callback_data: 'full_report' }]);

  await safeSend(TG_CHAT, msg, { reply_markup: { inline_keyboard: keyboard } });
  console.log(`✅ Day check sent (${timeLabel}): ${activeCamps.length} camps, ${adsWithSpend.length} ads, ${weakAds.length} weak`);
}

// ── Friday 18:00 Weekly summary ───────────────────────────────
async function sendWeeklySummary() {
  if (new Date().getDay() !== 5) return; // только пятница

  const data = await fetchAllData('last_week');
  const { ov7, ov14, spend7, spendPrev, messages, leads, insightMap, activeCampaigns, adsWithData } = data;

  const ctr = parseFloat(ov7.ctr || 0);
  const cpm = parseFloat(ov7.cpm || 0);
  const spendSign = spendPrev >= 0 ? '+' : '';
  const ctrEmoji  = ctr >= 3 ? '✅' : ctr >= 1.5 ? '🟡' : '🔴';

  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  let msg = `📅 <b>Итог недели</b>\n<i>${today}</i>\n──────────────\n\n`;
  msg += `💰 Расход: <b>$${fmt(spend7)}</b> (${spendSign}$${fmt(Math.abs(spendPrev))} vs пред. пер.)\n`;
  msg += `${ctrEmoji} CTR: <b>${fmt(ctr)}%</b>\n`;
  msg += `📊 CPM: <b>$${fmt(cpm)}</b>\n`;
  if (messages) msg += `💬 Диалоги: <b>${messages}</b>\n`;
  if (leads)    msg += `📋 Лиды: <b>${leads}</b>\n`;

  // Best / worst campaigns by CTR
  const campsArr = Object.values(insightMap).filter(c => parseFloat(c.spend || 0) > 1);
  const sorted   = [...campsArr].sort((a, b) => parseFloat(b.ctr || 0) - parseFloat(a.ctr || 0));
  const best     = sorted.slice(0, 2);
  const worst    = sorted.slice(-2).filter(c => parseFloat(c.ctr || 0) < 2);

  if (best.length > 0) {
    msg += `\n🏆 <b>Лучшие кампании:</b>\n`;
    for (const c of best) {
      msg += `✅ ${c.campaign_name} — CTR ${fmt(parseFloat(c.ctr || 0))}% | $${fmt(parseFloat(c.spend || 0))}\n`;
    }
  }
  if (worst.length > 0) {
    msg += `\n⚠️ <b>Слабые кампании:</b>\n`;
    for (const c of worst) {
      msg += `🔴 ${c.campaign_name} — CTR ${fmt(parseFloat(c.ctr || 0))}% | $${fmt(parseFloat(c.spend || 0))}\n`;
    }
  }

  msg += `\n💡 <i>Для полного анализа — «Полный отчёт»</i>`;

  await bot.sendMessage(TG_CHAT, msg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '📊 Полный отчёт за неделю', callback_data: 'full_report' }],
      [{ text: '📊 Таблица аналитики', url: SHEET_URL }],
    ]},
  });
  console.log('✅ Weekly summary sent');
}

// ── Critical alert: sends to both group chat and personal DM ──
async function sendCritical(text, keyboard = []) {
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  await safeSend(TG_CHAT, text, { reply_markup: { inline_keyboard: keyboard } });
  if (TG_PERSONAL && TG_PERSONAL !== TG_CHAT) {
    try { await safeSend(TG_PERSONAL, text, { reply_markup: { inline_keyboard: keyboard } }); }
    catch (e) { console.warn('⚠️ Personal DM failed:', e.message); }
  }
}

// ── Billing check ─────────────────────────────────────────────
// account_status codes: 1=Active 2=Disabled 3=Unsettled 7=PendingReview 9=GracePeriod 100=PendingClosure 101=Closed
const BILLING_STATUS = {
  1: { ok: true,  emoji: '✅', label: 'Активен' },
  2: { ok: false, emoji: '🔴', label: 'ОТКЛЮЧЁН' },
  3: { ok: false, emoji: '🔴', label: 'НЕ ОПЛАЧЕН' },
  7: { ok: false, emoji: '🟡', label: 'На проверке' },
  9: { ok: false, emoji: '🟠', label: 'Льготный период' },
  100:{ ok: false, emoji: '🔴', label: 'Ожидает закрытия' },
  101:{ ok: false, emoji: '🔴', label: 'ЗАКРЫТ' },
};

const BILLING_URL    = 'https://www.facebook.com/ads/manager/billing/payment_activity';
const ADD_FUNDS_URL  = 'https://www.facebook.com/ads/manager/billing/payment_methods';

let lastBillingStatus = 1; // track changes
let billingAlertSentToday = false;

async function checkBilling(silent = false) {
  const data = await metaGet(`/${AD_ACCOUNT}`, {
    fields: 'balance,amount_spent,spend_cap,account_status,currency,funding_source_details',
  }).catch(() => null);
  if (!data) return null;

  const status      = data.account_status ?? 1;
  const balanceCents= parseInt(data.balance || 0);        // prepaid credit in cents
  const spentCents  = parseInt(data.amount_spent || 0);   // total historical spend in cents
  const capCents    = parseInt(data.spend_cap || 0);      // 0 = no cap
  const currency    = data.currency || 'USD';
  const card        = data.funding_source_details?.display_string || 'карта не привязана';

  const balanceUSD  = balanceCents / 100;
  const spentUSD    = spentCents   / 100;
  const capUSD      = capCents     / 100;

  const info = BILLING_STATUS[status] || { ok: false, emoji: '❓', label: `Статус ${status}` };

  // Build billing keyboard
  const billingKeyboard = [
    [
      { text: '💳 Биллинг Meta', url: BILLING_URL },
      { text: '➕ Пополнить счёт', url: ADD_FUNDS_URL },
    ],
  ];

  // ── Always alert on status change ────────────────────────────
  if (status !== lastBillingStatus) {
    lastBillingStatus = status;
    if (!info.ok) {
      const alertMsg = `🚨 <b>БИЛЛИНГ: ${info.emoji} ${info.label.toUpperCase()}</b>\n\n`
        + `Рекламный кабинет может быть заблокирован!\n`
        + `Привязана: <b>${card}</b>\n`
        + `Потрачено всего: <b>$${fmt(spentUSD)}</b>\n\n`
        + `Немедленно проверь биллинг в Meta.`;
      await sendCritical(alertMsg, billingKeyboard);
      return data;
    }
  }

  // ── Alert if account not active ───────────────────────────────
  if (!info.ok && !billingAlertSentToday) {
    billingAlertSentToday = true;
    const alertMsg = `${info.emoji} <b>Биллинг: ${info.label}</b>\n\n`
      + `Рекламный аккаунт не активен — проверь биллинг.\n`
      + `Карта: <b>${card}</b>`;
    await sendCritical(alertMsg, billingKeyboard);
    return data;
  }
  // Reset daily flag at midnight
  const h = new Date().getHours();
  if (h === 0) billingAlertSentToday = false;

  // ── Spending cap warning ──────────────────────────────────────
  if (capUSD > 0 && spentUSD >= capUSD * 0.9) {
    const pct = ((spentUSD / capUSD) * 100).toFixed(0);
    const alertMsg = `⚠️ <b>Лимит бюджета на ${pct}%!</b>\n\n`
      + `Потрачено: <b>$${fmt(spentUSD)}</b> из лимита <b>$${fmt(capUSD)}</b>\n`
      + `Скоро реклама может остановиться.`;
    await sendCritical(alertMsg, billingKeyboard);
  }

  // ── Return formatted billing info string (for morning report) ─
  return {
    statusInfo: info,
    balanceUSD,
    spentUSD,
    capUSD,
    card,
    currency,
    keyboard: billingKeyboard,
  };
}

// ── /billing command: show full billing status ────────────────
async function sendBillingReport(chatId) {
  const b = await checkBilling(true);
  if (!b) {
    await safeSend(chatId, '❌ Не удалось получить данные биллинга.');
    return;
  }
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  let msg = `💳 <b>Биллинг Meta Ads</b>\n<i>${today}</i>\n──────────────\n\n`;
  msg += `${b.statusInfo.emoji} Статус: <b>${b.statusInfo.label}</b>\n`;
  msg += `💳 Карта: <b>${b.card}</b>\n`;
  if (b.balanceUSD > 0) msg += `💰 Баланс: <b>$${fmt(b.balanceUSD)}</b>\n`;
  msg += `📊 Потрачено всего: <b>$${fmt(b.spentUSD)}</b>\n`;
  if (b.capUSD > 0) {
    const pct = ((b.spentUSD / b.capUSD) * 100).toFixed(0);
    msg += `🔒 Лимит расходов: <b>$${fmt(b.capUSD)}</b> (использовано ${pct}%)\n`;
  }
  msg += `\nЧтобы пополнить счёт — открой биллинг Meta:`;

  await safeSend(chatId, msg, { reply_markup: { inline_keyboard: b.keyboard } });
}

// ── Wire up schedule ──────────────────────────────────────────
scheduleDaily(9,  0,  sendMorningReport,                       'morning');
scheduleDaily(13, 0,  sendDayCheck,                            'check-13');
scheduleDaily(18, 0,  async () => { await sendDayCheck(); await sendWeeklySummary(); }, 'check-18');

// Billing check every 6 hours (catches issues between morning reports)
function scheduleBillingCheck() {
  const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
  setInterval(async () => {
    try { await checkBilling(); }
    catch (e) { console.warn('⚠️ billing check error:', e.message); }
  }, CHECK_INTERVAL);
}
scheduleBillingCheck();

// ─── Startup message ──────────────────────────────────────────
console.log('🤖 Таргет АНАЛИТИКА bot started, polling...');
sendStartMessage(TG_CHAT).catch(() => {});

