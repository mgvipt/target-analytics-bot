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

// Read row 2 to see the date headers (B2:AF2)
const headerRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!A1:AF55",
  valueRenderOption: 'FORMULA',
});
const formulaRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!A1:AF55",
  valueRenderOption: 'FORMATTED_VALUE',
});

const rows    = headerRes.data.values || [];
const vrows   = formulaRes.data.values || [];

// Find first data column (first date column after label column A)
const row2 = rows[1] || [];
console.log('Row 2 (headers): A="'+row2[0]+'" B="'+row2[1]+'" C="'+row2[2]+'" ... AF="'+row2[31]+'"');

// Print full structure: row index, col A label, col AF formula, col AF value
console.log('\n=== FULL STRUCTURE: Row | Label | AF_formula | AF_value | B_formula | B_value ===');
for (let r = 0; r < Math.min(rows.length, 52); r++) {
  const frow = rows[r]   || [];
  const vrow = vrows[r]  || [];
  const label   = String(frow[0] || '').slice(0, 35);
  const afFml   = String(frow[31] || '').slice(0, 80);
  const afVal   = String(vrow[31] || '').slice(0, 20);
  const bFml    = String(frow[1]  || '').slice(0, 40);
  const bVal    = String(vrow[1]  || '').slice(0, 20);
  if (label || afFml || afVal || bFml) {
    console.log('R'+(r+1).toString().padStart(2)+' | "'+label.padEnd(35)+'" | AF: fml="'+afFml.padEnd(40)+'" val="'+afVal+'" | B: fml="'+bFml+'"');
  }
}

// Check which columns have data in row 3 (Затраты)
console.log('\n=== ROW 3 (Затраты) — all columns with data ===');
const row3f = rows[2]  || [];
const row3v = vrows[2] || [];
for (let c = 0; c < Math.max(row3f.length, row3v.length); c++) {
  const fml = String(row3f[c] || '');
  const val = String(row3v[c] || '');
  if (fml || val) {
    function colLetter(n) {
      let s=''; n+=1;
      while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}
      return s;
    }
    console.log('  '+colLetter(c)+(3)+': fml="'+fml.slice(0,50)+'" val="'+val+'"');
  }
}
