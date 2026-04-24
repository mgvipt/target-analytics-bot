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

// Read unformatted values for ALL rows that contain currency data in daily columns
// Rows that have spending ($): 3 (Direct spend), 18 (Traffic spend)
// Also rows 8,9,14,23,24,28,33,41,42,44 could have daily values written by bot

const rawRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!A1:AE55",
  valueRenderOption: 'UNFORMATTED_VALUE',
});

const rawRows = rawRes.data.values || [];
console.log('Total rows read:', rawRows.length);

// Find rows where cells contain text strings with $ signs
const updates = [];

for (let r = 0; r < rawRows.length; r++) {
  const row = rawRows[r] || [];
  const rowUpdates = [];
  let hasTextMoney = false;

  for (let c = 1; c < 31; c++) { // B=1 to AE=30
    const v = row[c];
    if (v === undefined || v === null || v === '') continue;

    if (typeof v === 'string') {
      // Text cell — try to parse as number
      const cleaned = v.replace(/[$,\s]/g, '').replace(',', '.');
      const num = parseFloat(cleaned);
      if (!isNaN(num)) {
        hasTextMoney = true;
        // Column letter
        function colLetter(n) {
          let s = ''; n += 1;
          while (n > 0) { const r = (n-1)%26; s = String.fromCharCode(65+r)+s; n = Math.floor((n-1)/26); }
          return s;
        }
        rowUpdates.push({ col: c, num, orig: v, cell: `'Апрель 2026'!${colLetter(c)}${r+1}` });
      }
    }
  }

  if (hasTextMoney) {
    console.log(`Row ${r+1} (label="${String(row[0]||'').slice(0,30)}"): ${rowUpdates.length} text-money cells`);
    for (const u of rowUpdates.slice(0,3)) {
      console.log(`  ${u.cell}: "${u.orig}" → ${u.num}`);
    }
    if (rowUpdates.length > 3) console.log(`  ... and ${rowUpdates.length-3} more`);
    updates.push(...rowUpdates);
  }
}

console.log(`\nTotal cells to convert: ${updates.length}`);

if (updates.length === 0) {
  console.log('✅ All daily cells are already numbers!');
  process.exit(0);
}

// Write numbers back
const batchData = updates.map(u => ({ range: u.cell, values: [[u.num]] }));

// Process in chunks of 100
const CHUNK = 100;
for (let i = 0; i < batchData.length; i += CHUNK) {
  const chunk = batchData.slice(i, i + CHUNK);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: chunk },
  });
  console.log(`Wrote chunk ${Math.floor(i/CHUNK)+1}/${Math.ceil(batchData.length/CHUNK)}`);
}

console.log('\n✅ Конвертация завершена!');

// Verify: read AF3 and AF18 after
await new Promise(r => setTimeout(r, 2000));
const checkRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!AF3:AF36",
  valueRenderOption: 'FORMATTED_VALUE',
});
const vals = checkRes.data.values || [];
const labels = {1:'Затраты Direct',2:'Показы',3:'Охват',4:'Клики',6:'CPM',7:'CPC',8:'CTR',9:'CR',11:'Результаты',12:'CPL',16:'Затраты Traffic',17:'Показы',18:'Охват',19:'Клики',21:'CPM',22:'CPC',23:'CTR',25:'Результаты',26:'CPL',30:'Всего инвестировано',31:'Цена заявки',32:'Показы всего',33:'Охват всего',34:'Клики всего'};
console.log('\n=== AF3:AF36 после конвертации ===');
for (let i = 0; i < vals.length; i++) {
  const v = vals[i]?.[0];
  if (v && labels[i]) console.log(`  AF${i+3} (${labels[i]}): ${v}`);
}
