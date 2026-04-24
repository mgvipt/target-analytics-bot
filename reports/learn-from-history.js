/**
 * learn-from-history.js
 *
 * Глубокий анализ исторических данных Meta Ads.
 * Извлекает паттерны, генерирует инсайты через Claude, сохраняет в brain.db.
 *
 * Запуск: node reports/learn-from-history.js
 * Доп. аккаунт: node reports/learn-from-history.js act_XXXXXXXXXX
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { addInsight, addKnowledge, getBrainStats } from './agent-brain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env
const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
for (const line of envContent.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const TOKEN    = process.env.META_ACCESS_TOKEN;
const BASE     = 'https://graph.facebook.com/v21.0';
// If CLI arg provided → only that account; without arg → main account
const ACCOUNTS = process.argv[2]
  ? [process.argv[2]]
  : [process.env.META_AD_ACCOUNT_ID];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function metaGet(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('access_token', TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

// Fetch all pages
async function fetchAll(path, params = {}) {
  let results = [];
  let r = await metaGet(path, { ...params, limit: 500 });
  results.push(...(r.data || []));
  while (r.paging?.next) {
    const next = new URL(r.paging.next);
    const p = {};
    next.searchParams.forEach((v, k) => { if (k !== 'access_token') p[k] = v; });
    r = await metaGet(path, p);
    results.push(...(r.data || []));
  }
  return results;
}

function parseActions(actions = []) {
  const m = {};
  for (const a of actions) m[a.action_type] = parseInt(a.value || 0);
  return m;
}

async function analyzeAccount(accountId) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 Анализирую аккаунт: ${accountId}`);
  console.log('═'.repeat(60));

  // ── 1. Месячные данные по кампаниям ─────────────────────────
  const since = new Date();
  since.setMonth(since.getMonth() - 36);
  const sinceStr = since.toISOString().split('T')[0];

  console.log(`\n⏳ Загружаю данные с ${sinceStr}...`);

  const [campMonthly, adsetData, adData] = await Promise.all([
    fetchAll(`/${accountId}/insights`, {
      fields: 'spend,impressions,clicks,ctr,cpm,cpc,reach,frequency,actions,campaign_name,objective,campaign_id',
      level: 'campaign',
      time_increment: 'monthly',
      time_range: JSON.stringify({ since: sinceStr, until: new Date().toISOString().split('T')[0] }),
    }),
    fetchAll(`/${accountId}/insights`, {
      fields: 'spend,impressions,clicks,ctr,cpm,reach,frequency,actions,adset_name,campaign_name,objective',
      level: 'adset',
      time_range: JSON.stringify({ since: sinceStr, until: new Date().toISOString().split('T')[0] }),
    }),
    fetchAll(`/${accountId}/insights`, {
      fields: 'spend,impressions,clicks,ctr,cpm,reach,frequency,actions,ad_name,campaign_name,objective',
      level: 'ad',
      time_range: JSON.stringify({ since: sinceStr, until: new Date().toISOString().split('T')[0] }),
    }),
  ]);

  console.log(`✅ Загружено: ${campMonthly.length} мес. записей, ${adsetData.length} групп, ${adData.length} объявлений`);

  if (campMonthly.length === 0) {
    console.log('⚠️  Нет данных для анализа');
    return;
  }

  // ── 2. Агрегация данных ──────────────────────────────────────

  // По целям (objective)
  const byObjective = {};
  for (const r of campMonthly) {
    const obj = r.objective || 'UNKNOWN';
    if (!byObjective[obj]) byObjective[obj] = { spend: 0, clicks: 0, impressions: 0, results: 0, records: 0, reach: 0 };
    byObjective[obj].spend       += parseFloat(r.spend || 0);
    byObjective[obj].clicks      += parseInt(r.clicks || 0);
    byObjective[obj].impressions += parseInt(r.impressions || 0);
    byObjective[obj].reach       += parseInt(r.reach || 0);
    byObjective[obj].records     += 1;
    const acts = parseActions(r.actions);
    byObjective[obj].results += (acts['onsite_conversion.messaging_conversation_started_7d'] || 0)
                              + (acts['lead'] || 0)
                              + (acts['purchase'] || 0)
                              + (acts['link_click'] || 0);
  }

  // По месяцам (сезонность)
  const byMonth = {};
  for (const r of campMonthly) {
    const month = r.date_start?.slice(0, 7) || 'unknown';
    if (!byMonth[month]) byMonth[month] = { spend: 0, clicks: 0, impressions: 0, ctr_sum: 0, count: 0 };
    byMonth[month].spend       += parseFloat(r.spend || 0);
    byMonth[month].clicks      += parseInt(r.clicks || 0);
    byMonth[month].impressions += parseInt(r.impressions || 0);
    byMonth[month].ctr_sum     += parseFloat(r.ctr || 0);
    byMonth[month].count       += 1;
  }

  // Лучшие/худшие кампании по CTR
  const campAgg = {};
  for (const r of campMonthly) {
    const name = r.campaign_name || r.campaign_id;
    if (!campAgg[name]) campAgg[name] = { spend: 0, clicks: 0, impressions: 0, objective: r.objective, results: 0 };
    campAgg[name].spend       += parseFloat(r.spend || 0);
    campAgg[name].clicks      += parseInt(r.clicks || 0);
    campAgg[name].impressions += parseInt(r.impressions || 0);
    const acts = parseActions(r.actions);
    campAgg[name].results += (acts['onsite_conversion.messaging_conversation_started_7d'] || 0)
                           + (acts['lead'] || 0)
                           + (acts['purchase'] || 0);
  }
  for (const c of Object.values(campAgg)) {
    c.ctr = c.impressions > 0 ? (c.clicks / c.impressions * 100) : 0;
    c.cpl = c.results > 0 ? c.spend / c.results : 0;
    c.cpc = c.clicks > 0 ? c.spend / c.clicks : 0;
  }

  const sortedCamps = Object.entries(campAgg)
    .filter(([, c]) => c.spend > 10)
    .sort(([, a], [, b]) => b.ctr - a.ctr);

  const top5  = sortedCamps.slice(0, 5);
  const worst5 = sortedCamps.slice(-5).reverse();
  const top5cpl = Object.entries(campAgg)
    .filter(([, c]) => c.results > 0)
    .sort(([, a], [, b]) => a.cpl - b.cpl)
    .slice(0, 5);

  // Лучшие объявления (по CTR)
  const topAds = adData
    .filter(a => parseFloat(a.spend||0) > 5)
    .map(a => ({
      name: a.ad_name,
      campaign: a.campaign_name,
      ctr: parseFloat(a.ctr || 0),
      spend: parseFloat(a.spend || 0),
      cpm: parseFloat(a.cpm || 0),
      objective: a.objective,
    }))
    .sort((a, b) => b.ctr - a.ctr)
    .slice(0, 10);

  // Итоговые цифры
  const totalSpend  = campMonthly.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
  const totalClicks = campMonthly.reduce((s, r) => s + parseInt(r.clicks || 0), 0);
  const totalImpr   = campMonthly.reduce((s, r) => s + parseInt(r.impressions || 0), 0);
  const avgCTR      = totalImpr > 0 ? (totalClicks / totalImpr * 100) : 0;
  const dates       = campMonthly.map(r => r.date_start).sort();

  // ── 3. Строим промпт для Claude ──────────────────────────────

  const objSummary = Object.entries(byObjective)
    .map(([obj, d]) => {
      const ctr = d.impressions > 0 ? (d.clicks / d.impressions * 100).toFixed(2) : '0';
      const cpl = d.results > 0 ? (d.spend / d.results).toFixed(2) : 'N/A';
      return `  ${obj}: расход $${d.spend.toFixed(0)}, CTR ${ctr}%, CPL $${cpl}, охват ${d.reach.toLocaleString()}`;
    }).join('\n');

  const monthSummary = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, d]) => {
      const ctr = d.impressions > 0 ? (d.clicks / d.impressions * 100).toFixed(2) : '0';
      return `  ${m}: $${d.spend.toFixed(0)} расход, CTR ${ctr}%`;
    }).join('\n');

  const top5str = top5.map(([name, c]) =>
    `  "${name.slice(0, 50)}" — CTR ${c.ctr.toFixed(2)}%, расход $${c.spend.toFixed(0)}, цель: ${c.objective}`
  ).join('\n');

  const worst5str = worst5.map(([name, c]) =>
    `  "${name.slice(0, 50)}" — CTR ${c.ctr.toFixed(2)}%, расход $${c.spend.toFixed(0)}, цель: ${c.objective}`
  ).join('\n');

  const cplStr = top5cpl.map(([name, c]) =>
    `  "${name.slice(0, 50)}" — CPL $${c.cpl.toFixed(2)}, результатов ${c.results}, расход $${c.spend.toFixed(0)}`
  ).join('\n');

  const topAdsStr = topAds.map(a =>
    `  "${a.name?.slice(0, 50)}" — CTR ${a.ctr.toFixed(2)}%, расход $${a.spend.toFixed(0)}, цель: ${a.objective}`
  ).join('\n');

  const prompt = `Ты — эксперт по таргетированной рекламе Meta Ads. Проанализируй данные рекламного кабинета и извлеки КОНКРЕТНЫЕ, ПРИМЕНИМЫЕ инсайты.

ДАННЫЕ АККАУНТА ${accountId}:
Период: ${dates[0]} — ${dates[dates.length - 1]}
Всего расход: $${totalSpend.toFixed(2)}
Всего кампаний: ${Object.keys(campAgg).length}
Средний CTR: ${avgCTR.toFixed(2)}%

РЕЗУЛЬТАТЫ ПО ЦЕЛЯМ КАМПАНИЙ:
${objSummary}

ДИНАМИКА ПО МЕСЯЦАМ (расход и CTR):
${monthSummary}

ТОП-5 КАМПАНИЙ ПО CTR:
${top5str}

ХУДШИЕ 5 КАМПАНИЙ ПО CTR:
${worst5str}

${top5cpl.length > 0 ? `ТОП КАМПАНИИ ПО НИЗКОМУ CPL:\n${cplStr}` : ''}

ТОП-10 ОБЪЯВЛЕНИЙ ПО CTR:
${topAdsStr}

ЗАДАЧА: Сгенерируй ровно 15 конкретных инсайтов на основе ЭТИХ РЕАЛЬНЫХ ДАННЫХ.
Каждый инсайт должен быть:
- Конкретным (с цифрами из данных)
- Применимым (что делать дальше)
- Уникальным (не повторяй общие знания)

Формат СТРОГО — каждый инсайт на новой строке, начиная с категории в квадратных скобках:
[категория] Текст инсайта с конкретными цифрами и выводом.

Категории: objective, ctr, cpl, audience, creative, budget, seasonality, scale, warning, opportunity`;

  console.log('\n🤖 Отправляю данные Claude для анализа...');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const aiText = response.content[0]?.text || '';
  console.log('\n📝 Инсайты от Claude:\n');
  console.log(aiText);

  // ── 4. Парсим и сохраняем инсайты ────────────────────────────
  const lines = aiText.split('\n').filter(l => l.trim().startsWith('['));
  let saved = 0;
  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s*(.+)/);
    if (match) {
      const [, category, insight] = match;
      addInsight(null, category.toLowerCase().trim(), insight.trim(), 'history');
      saved++;
    }
  }

  // ── 5. Сохраняем сырые паттерны как знания ───────────────────

  // Лучший objective для этого типа аккаунта
  const bestObj = Object.entries(byObjective)
    .filter(([, d]) => d.spend > 50)
    .sort(([, a], [, b]) => {
      const ctrA = a.impressions > 0 ? a.clicks / a.impressions : 0;
      const ctrB = b.impressions > 0 ? b.clicks / b.impressions : 0;
      return ctrB - ctrA;
    })[0];

  if (bestObj) {
    const [obj, d] = bestObj;
    const ctr = (d.clicks / d.impressions * 100).toFixed(2);
    addKnowledge(
      'кабинет', 'objective',
      `Аккаунт ${accountId}: лучший CTR у цели ${obj} — ${ctr}% при расходе $${d.spend.toFixed(0)}`,
      'universal', 8
    );
  }

  // Сезонность
  const monthlySpend = Object.entries(byMonth)
    .map(([m, d]) => ({ month: m.slice(5, 7), spend: d.spend, ctr: d.impressions > 0 ? d.clicks/d.impressions*100 : 0 }));
  const bestMonth = monthlySpend.sort((a, b) => b.ctr - a.ctr)[0];
  if (bestMonth) {
    const monthNames = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    addKnowledge(
      'кабинет', 'seasonality',
      `Аккаунт ${accountId}: лучший CTR в ${monthNames[parseInt(bestMonth.month)]} (${bestMonth.ctr.toFixed(2)}%) — усиливать бюджет в этот период`,
      'universal', 7
    );
  }

  console.log(`\n✅ Сохранено инсайтов: ${saved}`);
  console.log(`📊 Лучший objective: ${bestObj?.[0]} (CTR ${bestObj ? (bestObj[1].clicks/bestObj[1].impressions*100).toFixed(2) : 0}%)`);

  return { totalSpend, campaigns: Object.keys(campAgg).length, insights: saved };
}

// ── Main ──────────────────────────────────────────────────────

console.log('🧠 ОБУЧЕНИЕ АГЕНТА ПО ИСТОРИЧЕСКИМ ДАННЫМ META ADS');
console.log('='.repeat(60));

const results = [];
for (const accountId of ACCOUNTS) {
  if (!accountId) continue;
  try {
    const res = await analyzeAccount(accountId);
    if (res) results.push({ accountId, ...res });
  } catch (e) {
    console.error(`❌ Ошибка для ${accountId}:`, e.message);
  }
}

const stats = getBrainStats();
console.log('\n' + '='.repeat(60));
console.log('🎉 ОБУЧЕНИЕ ЗАВЕРШЕНО');
console.log('='.repeat(60));
for (const r of results) {
  console.log(`✅ ${r.accountId}: $${r.totalSpend?.toFixed(0)} расход, ${r.campaigns} кампаний, ${r.insights} инсайтов`);
}
console.log(`\n📊 База знаний теперь:`);
console.log(`   💡 Инсайтов: ${stats.insights}`);
console.log(`   📚 Знаний: ${stats.knowledge}`);
console.log(`\nАгент обучен на реальных данных твоих кабинетов! 🚀`);
