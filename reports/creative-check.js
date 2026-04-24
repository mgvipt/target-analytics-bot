#!/usr/bin/env node
import { META_TOKEN, AD_ACCOUNT, BASE_URL, THRESHOLDS } from './config.js';
import { sendTelegram, fmt, fmtMoney, isLearning, parseActions } from './tg.js';

async function metaGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  return res.json();
}

async function run() {
  const hour = new Date().getHours();
  const period = hour < 15 ? 'дневная' : 'вечерняя';
  const emoji = hour < 15 ? '☀️' : '🌆';

  // Get active ads with insights
  const [adsRaw, insightsRaw, campaignsRaw] = await Promise.all([
    metaGet(`/${AD_ACCOUNT}/ads`, {
      fields: 'id,name,status,adset_id,campaign_id,created_time',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: 100,
    }),
    metaGet(`/${AD_ACCOUNT}/insights`, {
      fields: 'ad_id,ad_name,adset_id,campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,frequency,actions',
      level: 'ad',
      date_preset: 'today',
      limit: 200,
    }),
    metaGet(`/${AD_ACCOUNT}/campaigns`, {
      fields: 'id,name,status,start_time',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: 50,
    }),
  ]);

  const activeAds = adsRaw.data || [];
  const insightMap = {};
  for (const row of insightsRaw.data || []) insightMap[row.ad_id] = row;

  const campaignMap = {};
  for (const c of campaignsRaw.data || []) campaignMap[c.id] = c;

  if (activeAds.length === 0) {
    await sendTelegram(`${emoji} <b>Проверка ${period} (нет активных объявлений)</b>\n\nВсе кампании на паузе.`);
    return;
  }

  const alerts = { red: [], orange: [], yellow: [], ok: [] };

  for (const ad of activeAds) {
    const ins = insightMap[ad.id] || {};
    const campaign = campaignMap[ad.campaign_id] || {};
    const learning = isLearning(campaign.start_time || ad.created_time);

    const ctr = parseFloat(ins.ctr || 0);
    const cpm = parseFloat(ins.cpm || 0);
    const freq = parseFloat(ins.frequency || 0);
    const spend = parseFloat(ins.spend || 0);
    const impressions = parseInt(ins.impressions || 0);

    // Skip if no spend today (not delivered yet)
    if (spend < 0.01 && impressions < 100) continue;

    const adInfo = {
      name: ad.name,
      campaign: ins.campaign_name || campaign.name || '—',
      ctr, cpm, freq, spend,
      learning,
    };

    if (learning) {
      adInfo.note = '🔄 обучение';
      alerts.ok.push(adInfo);
      continue;
    }

    if (ctr < THRESHOLDS.CTR_LOW && ctr > 0) {
      adInfo.reason = `CTR ${fmt(ctr)}% — критически низкий`;
      alerts.red.push(adInfo);
    } else if (freq >= THRESHOLDS.FREQUENCY_HIGH) {
      adInfo.reason = `Частота ${fmt(freq)} — аудитория выгорела`;
      alerts.red.push(adInfo);
    } else if (freq >= THRESHOLDS.FREQUENCY_WARN || (ctr < THRESHOLDS.CTR_WARN && ctr > 0)) {
      adInfo.reason = ctr < THRESHOLDS.CTR_WARN ? `CTR ${fmt(ctr)}% — ниже нормы` : `Частота ${fmt(freq)}`;
      alerts.orange.push(adInfo);
    } else {
      alerts.ok.push(adInfo);
    }
  }

  const total = alerts.red.length + alerts.orange.length + alerts.yellow.length + alerts.ok.length;
  if (total === 0) {
    await sendTelegram(`${emoji} <b>Проверка ${period}</b>\n\nСегодня ещё нет данных по активным объявлениям — мало показов. Проверю позже.`);
    return;
  }

  let msg = `${emoji} <b>ПРОВЕРКА КРЕАТИВОВ — ${period.toUpperCase()}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n`;

  if (alerts.red.length > 0) {
    msg += `\n🔴 <b>ВЫКЛЮЧИТЬ СЕЙЧАС (${alerts.red.length})</b>\n`;
    for (const a of alerts.red) {
      msg += `• <b>${a.name}</b>\n`;
      msg += `  📁 ${a.campaign}\n`;
      msg += `  ⚠️ ${a.reason} | Расход сегодня: ${fmtMoney(a.spend)}\n`;
    }
  }

  if (alerts.orange.length > 0) {
    msg += `\n🟠 <b>ПРОВЕРИТЬ (${alerts.orange.length})</b>\n`;
    for (const a of alerts.orange) {
      msg += `• <b>${a.name}</b>\n`;
      msg += `  📁 ${a.campaign}\n`;
      msg += `  ⚠️ ${a.reason} | CTR: ${fmt(a.ctr)}% | CPM: $${fmt(a.cpm)}\n`;
    }
  }

  if (alerts.ok.length > 0) {
    msg += `\n✅ <b>В НОРМЕ (${alerts.ok.length})</b>\n`;
    for (const a of alerts.ok) {
      const tag = a.note ? ` — ${a.note}` : '';
      msg += `• ${a.name}${tag} | CTR: ${fmt(a.ctr)}% | CPM: $${fmt(a.cpm)}\n`;
    }
  }

  if (alerts.red.length === 0 && alerts.orange.length === 0) {
    msg += `\n✅ Все активные объявления работают в норме`;
  }

  msg += `\n\n📋 <a href="https://docs.google.com/spreadsheets/d/1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g">Открыть таблицу аналитики</a>`;

  await sendTelegram(msg);
  console.log(`Creative check (${period}) sent:`, new Date().toISOString());
}

run().catch(async (err) => {
  console.error(err);
  await sendTelegram(`❌ Ошибка проверки креативов: ${err.message}`).catch(() => {});
});
