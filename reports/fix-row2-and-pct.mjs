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

// ── 1. Read current state of key cells ──────────────────────────
const checkRaw = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!A1:AF55",
  valueRenderOption: 'FORMATTED_VALUE',
});
const rows = checkRaw.data.values || [];

console.log('=== Текущие значения ключевых ячеек ===');
console.log('Row 1 (A1-G1):', (rows[0]||[]).slice(0,7));
console.log('Row 2 (B2-G2):', (rows[1]||[]).slice(1,7));
console.log('Row 3 AF3:', (rows[2]||[])[31]);   // AF3 = spend direct
console.log('Row 18 AF18:', (rows[17]||[])[31]); // AF18 = spend traffic
console.log('Row 32 AF32:', (rows[31]||[])[31]); // AF32 = total
console.log('Row 33 AF33:', (rows[32]||[])[31]); // AF33 = CPL total
console.log();

// ── 2. Restore row 2 date headers ───────────────────────────────
// B2:AE2 = "01.04.2026" through "30.04.2026"
const dateRow = [];
for (let d = 1; d <= 30; d++) {
  dateRow.push(`${String(d).padStart(2,'0')}.04.2026`);
}

console.log('Восстанавливаю заголовки дат в строке 2...');
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!B2:AE2",
  valueInputOption: 'RAW', // RAW = store as text, don't parse as date
  requestBody: { values: [dateRow] },
});
console.log('✅ Строка 2 восстановлена:', dateRow.slice(0,5), '...');

// ── 3. Fix format for CTR/CR daily cells (rows 10,11,25): use NUMBER not PERCENT ──
// Values like 3.45 stored as number should display as "3.45" not "345%"
// Use custom format: 0.00"%" — stores 3.45, shows "3.45%"
const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
const sheetMeta = spreadsheetInfo.data.sheets?.find(s => s.properties.title === 'Апрель 2026');
const sheetId   = sheetMeta?.properties?.sheetId;

// For daily cells (B:AE) in % rows: use NUMBER type with literal % pattern
// "0.00""%"" means: show as 0.00 with literal "%" appended
const pctLiteralFormat = { numberFormat: { type: 'NUMBER', pattern: '0.00"%"' } };

const formatReqs = [];
for (const row of [10, 11, 25]) {
  formatReqs.push({
    repeatCell: {
      range: { sheetId, startRowIndex: row-1, endRowIndex: row, startColumnIndex: 1, endColumnIndex: 31 },
      cell: { userEnteredFormat: pctLiteralFormat },
      fields: 'userEnteredFormat.numberFormat',
    },
  });
}

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: SHEET_ID,
  requestBody: { requests: formatReqs },
});
console.log('✅ Формат для строк CTR/CR обновлён (0.00"%" вместо PERCENT)');

// ── 4. Final verification ────────────────────────────────────────
await new Promise(r => setTimeout(r, 2000));

const finalRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!A1:AF55",
  valueRenderOption: 'FORMATTED_VALUE',
});
const frows = finalRes.data.values || [];

console.log('\n=== ФИНАЛЬНАЯ ПРОВЕРКА ===');
console.log('Row 2 B-G:', (frows[1]||[]).slice(1,7));
console.log();

const checks = [
  [3,  'AF3  Затраты Direct'],
  [4,  'AF4  Показы Direct'],
  [5,  'AF5  Охват Direct'],
  [6,  'AF6  Клики Direct'],
  [8,  'AF8  CPM Direct'],
  [9,  'AF9  CPC Direct'],
  [10, 'AF10 CTR Direct'],
  [11, 'AF11 CR Direct'],
  [13, 'AF13 Результаты'],
  [14, 'AF14 CPL Direct'],
  [18, 'AF18 Затраты Traffic'],
  [19, 'AF19 Показы Traffic'],
  [21, 'AF21 Клики Traffic'],
  [25, 'AF25 CTR Traffic'],
  [27, 'AF27 Результаты Traffic'],
  [28, 'AF28 CPL Traffic'],
  [32, 'AF32 Всего инвестировано'],
  [33, 'AF33 Цена заявки'],
  [34, 'AF34 Показы всего'],
  [36, 'AF36 Клики всего'],
];

for (const [row, label] of checks) {
  const val = (frows[row-1]||[])[31] || '';
  console.log(`  ${label}: ${val || '(пусто)'}`);
}
