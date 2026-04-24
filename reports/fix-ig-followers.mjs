/**
 * fix-ig-followers.mjs
 * 1. Fetches historical Instagram follower count via IG Insights API (April 2026)
 * 2. Clears the wrong 0s in row 37 (April 5-22)
 * 3. Writes real data where available, leaves cells empty when API has no data
 * 4. Shows what's still missing
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const DIR        = '/Users/macbook/Downloads/ТАРГЕТ/Аналитика через Клоуд/meta-ads-mcp';
const TOKEN_PATH = resolve(DIR, 'sheets-token.json');
const ENV_PATH   = resolve(DIR, '.env');
const SHEET_ID   = '1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';

// Load env
const envContent = readFileSync(ENV_PATH, 'utf-8');
for (const line of envContent.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const idx = t.indexOf('='); if (idx === -1) continue;
  const key = t.slice(0, idx).trim();
  const value = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  if (!process.env[key]) process.env[key] = value;
}

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const IG_ID      = process.env.META_IG_ACCOUNT_ID;
const API_VER    = process.env.META_API_VERSION || 'v21.0';
const BASE_URL   = `https://graph.facebook.com/${API_VER}`;

// Google Sheets setup
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
oauth2.setCredentials(tokens);
oauth2.on('tokens', (t) => {
  if (t.refresh_token) tokens.refresh_token = t.refresh_token;
  tokens.access_token = t.access_token;
  tokens.expiry_date  = t.expiry_date;
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
});
const sheets = google.sheets({ version: 'v4', auth: oauth2 });

// Meta API helper
async function metaGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('access_token', META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  return res.json();
}

// Column letter from 0-based index
function colLetter(idx) {
  let s = ''; idx += 1;
  while (idx > 0) { const r = (idx-1)%26; s = String.fromCharCode(65+r)+s; idx = Math.floor((idx-1)/26); }
  return s;
}

console.log('=== Исправление подписчиков Instagram в Апрель 2026 ===\n');
console.log(`IG Account ID: ${IG_ID}`);

// ── Step 1: Read current row 37 ───────────────────────────────
const rawRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!B37:AE37",
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const current37 = rawRes.data.values?.[0] || [];
console.log('\nТекущие значения R37 (B=Apr1 → AE=Apr30):');
current37.forEach((v, i) => {
  if (v !== '' && v !== null && v !== undefined) {
    console.log(`  ${colLetter(i+1)}37 (Apr${i+1}): ${v}`);
  }
});

// ── Step 2: Fetch current followers count ─────────────────────
console.log('\nПолучаю текущее количество подписчиков...');
const igCurrent = await metaGet(`/${IG_ID}`, { fields: 'followers_count,username' });
console.log('IG ответ:', JSON.stringify(igCurrent));
const currentFollowers = igCurrent.followers_count || 0;
console.log(`Текущие подписчики: ${currentFollowers}`);

// ── Step 3: Fetch historical follower_count from IG Insights ──
// The metric "follower_count" gives daily cumulative total (not delta)
// period=day, since/until in Unix timestamps or YYYY-MM-DD
console.log('\nПолучаю историческую статистику (follower_count)...');

const since = '2026-04-01';
const until = '2026-04-24'; // up to today (Apr 23 inclusive)

let insightsData = null;

// Try method 1: follower_count metric (cumulative)
const ins1 = await metaGet(`/${IG_ID}/insights`, {
  metric: 'follower_count',
  period: 'day',
  since,
  until,
});
console.log('\nIG Insights follower_count:', JSON.stringify(ins1).slice(0, 500));

if (ins1.data && ins1.data.length > 0) {
  insightsData = ins1.data[0]?.values || [];
  console.log(`Получено точек данных: ${insightsData.length}`);
}

// Try method 2: if follower_count doesn't work, try reach/profile views
// (sometimes follower_count is not available for all account types)
if (!insightsData || insightsData.length === 0) {
  console.log('\nfollower_count не доступен, пробую альтернативные метрики...');
  const ins2 = await metaGet(`/${IG_ID}/insights`, {
    metric: 'reach',
    period: 'day',
    since,
    until,
  });
  console.log('reach insights:', JSON.stringify(ins2).slice(0, 300));
}

// ── Step 4: Build day → followers map ────────────────────────
// insightsData elements: { value: 12345, end_time: "2026-04-02T07:00:00+0000" }
const dayFollowers = {}; // day (1-30) → followers count

if (insightsData && insightsData.length > 0) {
  for (const point of insightsData) {
    if (!point.end_time || point.value === undefined) continue;
    const date = new Date(point.end_time);
    const month = date.getMonth() + 1; // 1-based
    const day   = date.getDate();
    if (month === 4 && day >= 1 && day <= 30) {
      dayFollowers[day] = point.value;
    }
  }
  console.log('\nДанные по дням из Insights:');
  for (const [d, v] of Object.entries(dayFollowers)) {
    console.log(`  Apr ${d}: ${v}`);
  }
} else {
  console.log('\n⚠️ Insights API не вернул данные по подписчикам.');
  console.log('Используем текущее значение только для сегодня (Apr 23).');
}

// Today is Apr 23 — always write current value
const today = new Date();
if (today.getMonth() === 3 && today.getFullYear() === 2026) { // April 2026
  dayFollowers[today.getDate()] = currentFollowers;
  console.log(`\nЗаписываю сегодня (Apr ${today.getDate()}): ${currentFollowers}`);
}

// ── Step 5: Clear wrong zeros, write real data ─────────────────
const updates = [];

for (let day = 1; day <= 30; day++) {
  const cellIdx = day - 1; // B=0, C=1, ...
  const cellRef = `'Апрель 2026'!${colLetter(day)}37`; // B37=Apr1, C37=Apr2...

  const currentVal = current37[cellIdx];
  const hasZero    = currentVal === 0 || currentVal === '0';
  const hasRealVal = dayFollowers[day] !== undefined;

  if (hasRealVal) {
    // Write real value from API
    updates.push({ range: cellRef, values: [[dayFollowers[day]]] });
    if (hasZero) {
      console.log(`  Apr ${day}: 0 → ${dayFollowers[day]} (исправляю)`);
    } else if (!currentVal && currentVal !== 0) {
      console.log(`  Apr ${day}: (пусто) → ${dayFollowers[day]} (заполняю)`);
    }
  } else if (hasZero) {
    // Clear wrong zero → empty string
    updates.push({ range: cellRef, values: [['']] });
    console.log(`  Apr ${day}: 0 → (пусто) (убираю ложный ноль)`);
  }
  // If no data and no zero → leave as is
}

console.log(`\nОбновлений: ${updates.length}`);

if (updates.length > 0) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
  });
  console.log('✅ Данные записаны!');
}

// ── Step 6: Show final state ──────────────────────────────────
await new Promise(r => setTimeout(r, 1500));
const finalRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!B37:AE37",
  valueRenderOption: 'FORMATTED_VALUE',
});
const final37 = finalRes.data.values?.[0] || [];
console.log('\n=== Итоговое состояние R37 (подписчики) ===');
for (let i = 0; i < 23; i++) {
  const v = final37[i];
  const label = v ? `${v}` : '(пусто)';
  console.log(`  Apr${i+1}: ${label}`);
}

// Show which days still need data
const missing = [];
for (let i = 0; i < 22; i++) { // Apr 1-22 (past days)
  if (!final37[i] || final37[i] === '' || final37[i] === '0') missing.push(i+1);
}
if (missing.length > 0) {
  console.log(`\n⚠️ Нет данных за: ${missing.map(d => `Apr ${d}`).join(', ')}`);
  console.log('Эти данные недоступны через API — нужно ввести вручную или дождаться API.');
} else {
  console.log('\n✅ Все дни заполнены!');
}
