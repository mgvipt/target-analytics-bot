#!/usr/bin/env node
import { META_TOKEN, AD_ACCOUNT, BASE_URL, THRESHOLDS } from './config.js';
import { fmt, fmtMoney, isLearning, getDaysSince, parseActions } from './tg.js';

const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT   = process.env.TELEGRAM_CHAT_ID;
const IG_ID     = process.env.META_IG_ACCOUNT_ID;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';

async function sendWithButtons(text, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
    }),
  });
  return res.json();
}

async function metaGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  return res.json();
}

async function run() {
  const today = new Date();
  const dateStr = today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });

  // 1. Account overview yesterday + Instagram followers
  const [overview, campaignsRaw, insightsRaw, igData, igDataPrev] = await Promise.all([
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: 'spend,impressions,clicks,reach,cpm,ctr,cpc,actions,frequency',
      date_preset: 'yesterday',
    }),
    metaGet(`/${AD_ACCOUNT}/campaigns`, {
      fields: 'id,name,status,objective,daily_budget,start_time',
      limit: 50,
    }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,actions,frequency',
      level: 'campaign',
      date_preset: 'yesterday',
      limit: 50,
    }),
    metaGet(`/${IG_ID}`, { fields: 'followers_count,name' }).catch(() => ({})),
    metaGet(`/${IG_ID}/insights`, {
      metric: 'follower_count',
      period: 'day',
      since: Math.floor((Date.now() - 2*86400000)/1000),
      until: Math.floor(Date.now()/1000),
    }).catch(() => ({})),
  ]);

  const ov = overview.data?.[0] || {};
  const spend = parseFloat(ov.spend || 0);
  const actions = parseActions(ov.actions);
  const messages = actions['onsite_conversion.messaging_conversation_started_7d'] || 0;
  const leads = actions['lead'] || 0;
  const videoViews = actions['video_view'] || 0;
  const saves = actions['onsite_conversion.post_save'] || 0;
  const costPerMsg = messages > 0 ? (spend / messages).toFixed(2) : '—';

  // Active campaigns
  const activeCampaigns = (campaignsRaw.data || []).filter(c => c.status === 'ACTIVE');
  const insightMap = {};
  for (const row of insightsRaw.data || []) insightMap[row.campaign_id] = row;

  // Build campaign lines
  let campaignLines = '';
  const recommendations = [];

  for (const c of activeCampaigns) {
    const ins = insightMap[c.id] || {};
    const cSpend = parseFloat(ins.spend || 0);
    const cCTR = parseFloat(ins.ctr || 0);
    const cCPM = parseFloat(ins.cpm || 0);
    const cFreq = parseFloat(ins.frequency || 0);
    const cActions = parseActions(ins.actions);
    const cMsg = cActions['onsite_conversion.messaging_conversation_started_7d'] || 0;
    const learning = isLearning(c.start_time);
    const daysSince = getDaysSince(c.start_time);
    const budget = c.daily_budget ? fmtMoney(parseInt(c.daily_budget) / 100) : '—';

    const learningTag = learning ? ` 🔄 <i>обучение (${daysSince}д)</i>` : '';
    const msgLine = cMsg > 0 ? `, диалогов: ${cMsg}` : '';

    campaignLines += `\n• <b>${c.name}</b>${learningTag}`;
    campaignLines += `\n  💰 ${fmtMoney(cSpend)} | CTR: ${fmt(cCTR)}% | CPM: $${fmt(cCPM)} | Частота: ${fmt(cFreq)}${msgLine}`;

    // Recommendations (only for non-learning)
    if (!learning) {
      if (cCTR > 0 && cCTR < THRESHOLDS.CTR_LOW) {
        recommendations.push(`🔴 <b>${c.name}</b> — CTR ${fmt(cCTR)}% критически низкий. Рекомендую выключить.`);
      } else if (cCTR < THRESHOLDS.CTR_WARN && cCTR > 0) {
        recommendations.push(`🟡 <b>${c.name}</b> — CTR ${fmt(cCTR)}% ниже нормы. Проверь креативы.`);
      }
      if (cFreq >= THRESHOLDS.FREQUENCY_HIGH) {
        recommendations.push(`🔴 <b>${c.name}</b> — Частота ${fmt(cFreq)}. Аудитория выгорела. Меняй таргетинг.`);
      } else if (cFreq >= THRESHOLDS.FREQUENCY_WARN) {
        recommendations.push(`🟠 <b>${c.name}</b> — Частота ${fmt(cFreq)}. Скоро выгорит — готовь новые креативы.`);
      }
      if (cSpend > 0 && c.daily_budget) {
        const budgetCents = parseInt(c.daily_budget);
        const spendCents = cSpend * 100;
        if (spendCents < budgetCents * THRESHOLDS.UNDERSPEND) {
          recommendations.push(`🟡 <b>${c.name}</b> — Недорасход бюджета (${fmt(spendCents/100, 0)}$ из ${fmt(budgetCents/100, 0)}$). Проверь аудиторию и ставки.`);
        }
      }
    }
  }

  // Compose message
  let msg = `📊 <b>УТРЕННИЙ ОТЧЁТ — ${dateStr}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `<b>💼 АККАУНТ ВЧЕРА</b>\n`;
  msg += `💰 Расход: <b>${fmtMoney(spend)}</b>\n`;
  msg += `👁 Охват: ${parseInt(ov.reach || 0).toLocaleString('ru')}\n`;
  msg += `📣 Показы: ${parseInt(ov.impressions || 0).toLocaleString('ru')}\n`;
  msg += `🖱 Клики: ${parseInt(ov.clicks || 0).toLocaleString('ru')}\n`;
  msg += `📈 CTR: ${fmt(ov.ctr)}% | CPM: $${fmt(ov.cpm)} | CPC: $${fmt(ov.cpc)}\n`;
  msg += `🔄 Частота: ${fmt(ov.frequency)}\n`;

  if (messages > 0) msg += `💬 Диалогов: <b>${messages}</b> | Цена диалога: $${costPerMsg}\n`;
  if (leads > 0) msg += `🎯 Лидов: <b>${leads}</b>\n`;
  if (videoViews > 0) msg += `▶️ Просмотров видео: ${videoViews.toLocaleString('ru')}\n`;
  if (saves > 0) msg += `🔖 Сохранений: ${saves}\n`;

  // Instagram followers
  const followers = igData.followers_count || 0;
  let followerGain = '';
  const followerValues = igDataPrev?.data?.[0]?.values;
  if (followerValues && followerValues.length >= 2) {
    const gain = followerValues[followerValues.length - 1].value - followerValues[followerValues.length - 2].value;
    followerGain = gain >= 0 ? ` (+${gain})` : ` (${gain})`;
  }
  if (followers > 0) msg += `\n👥 Подписчики Instagram: <b>${followers.toLocaleString('ru')}${followerGain}</b>\n`;

  msg += `\n<b>🚀 АКТИВНЫЕ КАМПАНИИ (${activeCampaigns.length})</b>`;
  msg += campaignLines || '\nНет активных кампаний';

  // Build action blocks: text explanation + buttons per campaign
  const keyboard = [];
  const actionBlocks = [];

  for (const c of activeCampaigns) {
    const ins = insightMap[c.id] || {};
    const cCTR = parseFloat(ins.ctr || 0);
    const cSpend = parseFloat(ins.spend || 0);
    const learning = isLearning(c.start_time);
    const budget = c.daily_budget ? (parseInt(c.daily_budget)/100).toFixed(0) : null;

    if (!learning && c.daily_budget) {
      if (cCTR > 0 && cCTR < THRESHOLDS.CTR_LOW) {
        // Bad CTR — recommend pause
        actionBlocks.push(
          `🔴 <b>${c.name}</b>\n` +
          `CTR ${fmt(cCTR)}% — критически низкий, кампания тратит деньги впустую.\n` +
          `👇 Нажми чтобы поставить на паузу:`
        );
        keyboard.push([{ text: `⏸ Поставить на паузу`, callback_data: `pause_${c.id}` }]);

      } else if (cCTR >= THRESHOLDS.CTR_WARN && cSpend > 1) {
        // Good CTR — recommend scaling
        actionBlocks.push(
          `✅ <b>${c.name}</b>\n` +
          `CTR ${fmt(cCTR)}% — хороший результат, кампания работает стабильно.\n` +
          `Бюджет сейчас: $${budget}/день. Можно масштабировать:\n` +
          `👇 Выбери на сколько увеличить бюджет:`
        );
        keyboard.push([
          { text: `📈 +20% ($${Math.round(parseInt(c.daily_budget)*1.2/100)}/д)`, callback_data: `budget_up_${c.id}_20` },
          { text: `📈 +50% ($${Math.round(parseInt(c.daily_budget)*1.5/100)}/д)`, callback_data: `budget_up_${c.id}_50` },
        ]);

      } else if (cCTR > 0 && cCTR < THRESHOLDS.CTR_WARN) {
        // Weak CTR — warn
        actionBlocks.push(
          `🟡 <b>${c.name}</b>\n` +
          `CTR ${fmt(cCTR)}% — ниже нормы. Стоит проверить креативы.\n` +
          `Бюджет сейчас: $${budget}/день.\n` +
          `👇 Что делаем:`
        );
        keyboard.push([
          { text: `📉 Снизить бюджет -20%`, callback_data: `budget_down_${c.id}_20` },
          { text: `⏸ Поставить на паузу`, callback_data: `pause_${c.id}` },
        ]);
      }
    }
  }

  if (recommendations.length > 0 || actionBlocks.length > 0) {
    msg += `\n\n<b>⚡ РЕКОМЕНДАЦИИ</b>`;
    if (recommendations.length > 0) msg += `\n` + recommendations.join('\n');
  } else if (activeCampaigns.filter(c => !isLearning(c.start_time)).length > 0) {
    msg += `\n\n✅ <b>Все кампании в норме</b>`;
  }

  if (actionBlocks.length > 0) {
    msg += `\n\n<b>🎛 ДЕЙСТВИЯ</b>\n`;
    msg += actionBlocks.join('\n\n');
  }

  msg += `\n\n📋 <a href="${SHEET_URL}">Открыть таблицу аналитики</a>`;
  msg += `\n<i>🔄 Следующая проверка в 13:00</i>`;

  // Global buttons at the bottom
  keyboard.push([
    { text: '📊 Скачать отчёт (Word)', callback_data: 'full_report' },
    { text: '☁️ На Диск', callback_data: 'upload_drive' },
  ]);
  keyboard.push([
    { text: '➕ Новая кампания', callback_data: 'new_campaign' },
    { text: '📋 Инструкция', callback_data: 'show_help' },
  ]);
  keyboard.push([
    { text: '📊 Таблица аналитики', url: SHEET_URL },
  ]);

  await sendWithButtons(msg, keyboard);
  console.log('Morning report sent:', new Date().toISOString());
}

run().catch(async (err) => {
  console.error(err);
  await sendTelegram(`❌ Ошибка утреннего отчёта: ${err.message}`).catch(() => {});
});
