#!/usr/bin/env node
import { META_TOKEN, AD_ACCOUNT, IG_ID, BASE_URL } from './config.js';
import { sendTelegram, fmt, fmtMoney, parseActions } from './tg.js';

async function metaGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  return res.json();
}

async function run() {
  const [overviewThis, overviewLast, campaignInsights, igData] = await Promise.all([
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: 'spend,impressions,clicks,reach,cpm,ctr,cpc,actions,frequency',
      date_preset: 'last_7d',
    }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: 'spend,impressions,clicks,reach,cpm,ctr,cpc,actions,frequency',
      date_preset: 'last_14d',
    }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,actions,frequency',
      level: 'campaign',
      date_preset: 'last_7d',
      limit: 50,
    }),
    metaGet(`/${IG_ID}`, { fields: 'followers_count,media_count,name' }).catch(() => ({})),
  ]);

  const ov = overviewThis.data?.[0] || {};
  const ovLast = overviewLast.data?.[0] || {};

  const spend = parseFloat(ov.spend || 0);
  const spendLast = parseFloat(ovLast.spend || 0) - spend;
  const spendDiff = spendLast > 0 ? ((spend - spendLast) / spendLast * 100).toFixed(0) : '—';
  const spendArrow = spend >= spendLast ? '📈' : '📉';

  const cpm = parseFloat(ov.cpm || 0);
  const cpmLast = parseFloat(ovLast.cpm || 0);
  const ctr = parseFloat(ov.ctr || 0);
  const ctrLast = parseFloat(ovLast.ctr || 0);

  const actions = parseActions(ov.actions);
  const messages = actions['onsite_conversion.messaging_conversation_started_7d'] || 0;
  const leads = actions['lead'] || 0;
  const videoViews = actions['video_view'] || 0;
  const costPerMsg = messages > 0 ? fmtMoney(spend / messages) : '—';

  // Top 3 and Bottom 3 campaigns
  const rows = (campaignInsights.data || [])
    .filter(r => parseFloat(r.spend || 0) > 0)
    .sort((a, b) => parseFloat(b.ctr || 0) - parseFloat(a.ctr || 0));

  const top3 = rows.slice(0, 3);
  const bottom3 = rows.slice(-3).reverse();

  const weekEnd = new Date();
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStr = `${weekStart.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} — ${weekEnd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;

  let msg = `📅 <b>НЕДЕЛЬНЫЙ ИТОГ | ${weekStr}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `<b>💼 ИТОГО ЗА НЕДЕЛЮ</b>\n`;
  msg += `💰 Расход: <b>${fmtMoney(spend)}</b> ${spendArrow} ${spendDiff !== '—' ? spendDiff + '%' : ''} vs прошлая неделя\n`;
  msg += `👁 Охват: ${parseInt(ov.reach || 0).toLocaleString('ru')}\n`;
  msg += `📣 Показы: ${parseInt(ov.impressions || 0).toLocaleString('ru')}\n`;
  msg += `📈 CTR: ${fmt(ctr)}% ${ctr >= ctrLast ? '📈' : '📉'} (было: ${fmt(ctrLast)}%)\n`;
  msg += `💵 CPM: $${fmt(cpm)} ${cpm <= cpmLast ? '✅' : '⚠️'} (было: $${fmt(cpmLast)})\n`;
  msg += `🔄 Частота: ${fmt(ov.frequency)}\n`;

  if (messages > 0) msg += `💬 Диалогов: <b>${messages}</b> | Цена: ${costPerMsg}\n`;
  if (leads > 0) msg += `🎯 Лидов: <b>${leads}</b>\n`;
  if (videoViews > 0) msg += `▶️ Просмотров: ${videoViews.toLocaleString('ru')}\n`;

  // Instagram followers
  const followers = igData.followers_count || 0;
  if (followers > 0) {
    msg += `\n👥 Подписчиков Instagram: <b>${followers.toLocaleString('ru')}</b>\n`;
    msg += `📸 Публикаций: ${igData.media_count || 0}\n`;
  }

  if (top3.length > 0) {
    msg += `\n<b>🏆 ЛУЧШИЕ КАМПАНИИ</b>\n`;
    for (const r of top3) {
      const rActions = parseActions(r.actions);
      const rMsg = rActions['onsite_conversion.messaging_conversation_started_7d'] || 0;
      msg += `• <b>${r.campaign_name}</b>\n`;
      msg += `  ${fmtMoney(r.spend)} | CTR: ${fmt(r.ctr)}% | CPM: $${fmt(r.cpm)}`;
      if (rMsg > 0) msg += ` | Диалоги: ${rMsg}`;
      msg += '\n';
    }
  }

  if (bottom3.length > 0 && rows.length > 3) {
    msg += `\n<b>⚠️ СЛАБЫЕ КАМПАНИИ</b>\n`;
    for (const r of bottom3) {
      msg += `• <b>${r.campaign_name}</b>\n`;
      msg += `  ${fmtMoney(r.spend)} | CTR: ${fmt(r.ctr)}% | CPM: $${fmt(r.cpm)}\n`;
    }
  }

  msg += `\n<b>📌 ПЛАН НА СЛЕДУЮЩУЮ НЕДЕЛЮ</b>\n`;
  if (top3.length > 0) msg += `✅ Масштабировать: ${top3[0].campaign_name}\n`;
  if (bottom3.length > 0 && rows.length > 3) msg += `⛔ Проверить или выключить: ${bottom3[0].campaign_name}\n`;
  msg += `🔄 Обновить креативы если частота > 2.5\n`;

  msg += `\n<i>Хорошей недели! 🚀</i>`;
  msg += `\n\n📋 <a href="https://docs.google.com/spreadsheets/d/1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g">Открыть таблицу аналитики</a>`;

  await sendTelegram(msg);
  console.log('Weekly report sent:', new Date().toISOString());
}

run().catch(async (err) => {
  console.error(err);
  await sendTelegram(`❌ Ошибка недельного отчёта: ${err.message}`).catch(() => {});
});
