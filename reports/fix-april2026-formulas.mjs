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

// ── 1. Check if daily values are numbers or text ──────────────
const unformRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!B3:AE3",
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const rawRow3 = unformRes.data.values?.[0] || [];
console.log('Row 3 raw (unformatted) — first 5 cells:', rawRow3.slice(0,5));
const areNumbers = rawRow3.every(v => v === '' || typeof v === 'number' || !isNaN(parseFloat(String(v).replace(/[$%,]/g,''))));
console.log('Daily cells are numbers:', areNumbers);

// Sum raw row3 values to compare with AF3
let dailySum = 0;
for (const v of rawRow3) {
  const num = parseFloat(String(v).replace(/[$,]/g,''));
  if (!isNaN(num)) dailySum += num;
}
console.log('Sum of daily Затраты (B3:AE3):', dailySum.toFixed(2));
console.log('Current AF3 value: $241.87 (hardcoded from ~10 days ago)\n');

// ── 2. Build proper AF column formulas ────────────────────────
// Row 3: Direct Затраты (SUM)
// Row 4: Direct Показы (SUM)
// Row 5: Direct Охват (SUM)
// Row 6: Direct Клики (SUM)
// Row 7: empty
// Row 8: Direct CPM = spend/impressions*1000
// Row 9: Direct CPC = spend/clicks
// Row 10: Direct CTR = clicks/impressions (%)
// Row 11: Direct CR = results/clicks (%)
// Row 12: empty
// Row 13: Direct Результаты (SUM)
// Row 14: Direct CPL = spend/results
// Row 18: Traffic Затраты (SUM)
// Row 19: Traffic Показы (SUM)
// Row 20: Traffic Охват (SUM)
// Row 21: Traffic Клики (SUM)
// Row 23: Traffic CPM
// Row 24: Traffic CPC
// Row 25: Traffic CTR
// Row 27: Traffic Результаты (SUM)
// Row 28: Traffic CPL
// Row 32: Всего инвестировано = Direct+Traffic spend
// Row 33: Цена заявки = total spend / total results
// Row 34: Показы всего = SUM
// Row 35: Охват всего = SUM
// Row 36: Клики всего = SUM

const formulas = [
  // [row (1-based), formula]
  [3,  '=IFERROR(SUM(B3:AE3);"")'],
  [4,  '=IFERROR(SUM(B4:AE4);"")'],
  [5,  '=IFERROR(SUM(B5:AE5);"")'],
  [6,  '=IFERROR(SUM(B6:AE6);"")'],
  [8,  '=IFERROR(AF3/(AF4/1000);"")'],
  [9,  '=IFERROR(AF3/AF6;"")'],
  [10, '=IFERROR(AF6/AF4;"")'],
  [11, '=IFERROR(AF13/AF6;"")'],
  [13, '=IFERROR(SUM(B13:AE13);"")'],
  [14, '=IFERROR(AF3/AF13;"")'],
  [18, '=IFERROR(SUM(B18:AE18);"")'],
  [19, '=IFERROR(SUM(B19:AE19);"")'],
  [20, '=IFERROR(SUM(B20:AE20);"")'],
  [21, '=IFERROR(SUM(B21:AE21);"")'],
  [23, '=IFERROR(AF18/(AF19/1000);"")'],
  [24, '=IFERROR(AF18/AF21;"")'],
  [25, '=IFERROR(AF21/AF19;"")'],
  [27, '=IFERROR(SUM(B27:AE27);"")'],
  [28, '=IFERROR(AF18/AF27;"")'],
  [32, '=IFERROR(AF3+AF18;"")'],
  [33, '=IFERROR(AF32/AF13;"")'],
  [34, '=IFERROR(AF4+AF19;"")'],
  [35, '=IFERROR(AF5+AF20;"")'],
  [36, '=IFERROR(AF6+AF21;"")'],
];

const updateData = formulas.map(([row, formula]) => ({
  range: `'Апрель 2026'!AF${row}`,
  values: [[formula]],
}));

console.log('Записываю формулы в AF колонку...');
for (const { range, values } of updateData) {
  console.log('  ', range, '←', values[0][0]);
}

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SHEET_ID,
  requestBody: { valueInputOption: 'USER_ENTERED', data: updateData },
});
console.log('\n✅ Формулы записаны!\n');

// ── 3. Fix number formats in AF column (monetary rows) ────────
// Use format that matches the sheet locale (Ukrainian: comma as decimal)
const monetaryRows = [3, 8, 9, 14, 18, 23, 24, 28, 32, 33, 41, 42, 44];
const percentRows  = [10, 11, 25];
const intRows      = [4, 5, 6, 13, 19, 20, 21, 27, 34, 35, 36];

// Get spreadsheet locale first
const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
const locale = spreadsheetInfo.data.properties?.locale || 'uk';
console.log('Spreadsheet locale:', locale);

// Get sheet ID for Апрель 2026
const sheetMeta = spreadsheetInfo.data.sheets?.find(s => s.properties.title === 'Апрель 2026');
const sheetId   = sheetMeta?.properties?.sheetId;
console.log('Sheet ID:', sheetId);

if (sheetId !== undefined) {
  const formatRequests = [];

  // Money format: $#,##0.00 or locale-specific
  const moneyFormat = { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } };
  const pctFormat   = { numberFormat: { type: 'PERCENT', pattern: '0.00%' } };
  const intFormat   = { numberFormat: { type: 'NUMBER', pattern: '#,##0' } };

  // AF column = column index 31 (0-based)
  for (const row of monetaryRows) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row-1, endRowIndex: row, startColumnIndex: 31, endColumnIndex: 32 },
        cell: { userEnteredFormat: moneyFormat },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }
  for (const row of percentRows) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row-1, endRowIndex: row, startColumnIndex: 31, endColumnIndex: 32 },
        cell: { userEnteredFormat: pctFormat },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }
  for (const row of intRows) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row-1, endRowIndex: row, startColumnIndex: 31, endColumnIndex: 32 },
        cell: { userEnteredFormat: intFormat },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  // Also format the ENTIRE sheet monetary cells (B:AE for monetary rows)
  // to use number format instead of text
  for (const row of monetaryRows) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row-1, endRowIndex: row, startColumnIndex: 1, endColumnIndex: 31 },
        cell: { userEnteredFormat: moneyFormat },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }
  for (const row of percentRows) {
    formatRequests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row-1, endRowIndex: row, startColumnIndex: 1, endColumnIndex: 31 },
        cell: { userEnteredFormat: pctFormat },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: formatRequests },
  });
  console.log('✅ Форматирование обновлено!');
}

// ── 4. Verify: read back AF column ────────────────────────────
await new Promise(r => setTimeout(r, 2000));
const checkRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!AF1:AF50",
  valueRenderOption: 'FORMATTED_VALUE',
});
console.log('\n=== Проверка AF колонки после исправления ===');
const checkRows = checkRes.data.values || [];
const rowLabels = {3:'Затраты Direct',4:'Показы',5:'Охват',6:'Клики',8:'CPM',9:'CPC',10:'CTR',11:'CR',13:'Результаты',14:'CPL',18:'Затраты Traffic',19:'Показы',20:'Охват',21:'Клики',23:'CPM',24:'CPC',25:'CTR',27:'Результаты',28:'CPL',32:'Всего инвестировано',33:'Цена заявки',34:'Показы всего',35:'Охват всего',36:'Клики всего'};
for (let r = 0; r < checkRows.length; r++) {
  const val = checkRows[r]?.[0];
  if (val && rowLabels[r+1]) {
    console.log(`  AF${r+1} (${rowLabels[r+1]}): ${val}`);
  }
}
