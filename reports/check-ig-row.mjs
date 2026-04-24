import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const DIR      = '/Users/macbook/Downloads/ТАРГЕТ/Аналитика через Клоуд/meta-ads-mcp';
const TOKEN_PATH = resolve(DIR, 'sheets-token.json');
const ENV_PATH   = resolve(DIR, '.env');
const SHEET_ID   = '1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';

const envContent = readFileSync(ENV_PATH, 'utf-8');
for (const line of envContent.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const idx = t.indexOf('='); if (idx === -1) continue;
  const key = t.slice(0, idx).trim();
  const value = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  if (!process.env[key]) process.env[key] = value;
}

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

// Read the full sheet to find Instagram followers row
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!A1:AE60",
  valueRenderOption: 'FORMATTED_VALUE',
});

const rows = res.data.values || [];
console.log('=== Все строки с метками (колонка A) ===');
for (let r = 0; r < rows.length; r++) {
  const label = String(rows[r]?.[0] || '').trim();
  const b     = String(rows[r]?.[1] || '');
  const c     = String(rows[r]?.[2] || '');
  const w     = String(rows[r]?.[21] || ''); // column W = day 22
  if (label) {
    console.log(`R${r+1}: "${label}" | B="${b}" C="${c}" ... W="${w}"`);
  }
}

// Find IG-related rows
console.log('\n=== Поиск строк с Инстаграм/подписчики ===');
for (let r = 0; r < rows.length; r++) {
  const label = String(rows[r]?.[0] || '').toLowerCase();
  if (label.includes('подпис') || label.includes('instagram') || label.includes('инстаграм') || label.includes('ig') || label.includes('фолловер')) {
    console.log(`R${r+1}: "${rows[r][0]}" | данные: ${rows[r].slice(1,25).map((v,i) => v ? `col${i+2}="${v}"` : '').filter(Boolean).join(', ')}`);
  }
}

// Show full rows 38-55 (likely bottom section)
console.log('\n=== Строки 38-55 (нижняя часть) ===');
for (let r = 37; r < Math.min(rows.length, 55); r++) {
  const row = rows[r] || [];
  const hasData = row.some(v => v !== '');
  if (hasData) {
    console.log(`R${r+1}: label="${row[0]}" | B="${row[1]}" C="${row[2]}" D="${row[3]}" E="${row[4]}" F="${row[5]}"`);
  }
}
