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

// Read formulas in column AF (column 32, index 31) of Апрель 2026
const fRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!AF:AF",
  valueRenderOption: 'FORMULA',
});
const vRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "'Апрель 2026'!AF:AF",
  valueRenderOption: 'FORMATTED_VALUE',
});

const formulas = fRes.data.values || [];
const values   = vRes.data.values || [];

console.log('=== Колонка AF (итого) в Апрель 2026 ===');
const fixes = [];

for (let r = 0; r < formulas.length; r++) {
  const formula = String((formulas[r] || [])[0] || '');
  const value   = String((values[r]   || [])[0] || '');

  if (!formula.startsWith('=')) continue;

  const isError = value.includes('#ERROR') || value.includes('#DIV') || value.includes('#VALUE') || value.includes('#N/A') || value.includes('#REF');
  console.log('AF'+(r+1)+': val="'+value+'" | formula="'+formula.slice(0,80)+'"');

  if (isError || formula.startsWith('=')) {
    // Convert comma separators to semicolons in IFERROR calls
    // and wrap any unwrapped division formulas
    let fixed = formula;

    // Replace IFERROR(x,y) → IFERROR(x;y) for locale compatibility
    fixed = fixed.replace(/=IFERROR\((.+),\s*(""|0|"")\s*\)$/s, (match, inner, fallback) => {
      return '=IFERROR(' + inner + ';' + fallback + ')';
    });

    // If still has error and not wrapped — wrap it
    if (isError && !fixed.toUpperCase().startsWith('=IFERROR')) {
      fixed = '=IFERROR(' + fixed.slice(1) + ';"")';
    } else if (isError && fixed.toUpperCase().startsWith('=IFERROR')) {
      // Already wrapped but still error — fix separator
      fixed = fixed.replace(/=IFERROR\((.+),\s*(.+)\)$/s, '=IFERROR($1;$2)');
    }

    if (fixed !== formula || isError) {
      fixes.push({ range: "'Апрель 2026'!AF"+(r+1), values: [[fixed]], original: formula, fixed });
    }
  }
}

console.log('\nБудет исправлено:', fixes.length, 'ячеек');
for (const f of fixes) {
  console.log('  '+f.range+': "'+f.original.slice(0,60)+'" → "'+f.fixed.slice(0,60)+'"');
}

if (fixes.length > 0) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: fixes.map(f => ({ range: f.range, values: f.values })),
    },
  });
  console.log('\n✅ Исправлено!');
} else {
  console.log('\nНичего не нужно исправлять.');
}

// Also check all sheets for IFERROR with comma that might now have errors
// and fix the ones this script introduced
console.log('\n=== Проверка формул с запятой во всех листах ===');
const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
const sheetList = meta.data.sheets.map(s => s.properties.title);

let totalFixed = 0;
for (const sheetName of sheetList) {
  if (sheetName.includes('Инструкция') || sheetName.includes('Стратегия') || sheetName.includes('Триггер')) continue;

  let allFRes;
  try {
    allFRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: "'"+sheetName+"'", valueRenderOption: 'FORMULA',
    });
  } catch { continue; }

  const allVRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: "'"+sheetName+"'", valueRenderOption: 'FORMATTED_VALUE',
  });

  const allFormulas = allFRes.data.values || [];
  const allValues   = allVRes.data.values || [];
  const sheetFixes  = [];

  for (let r = 0; r < allValues.length; r++) {
    const row  = allValues[r]   || [];
    const frow = allFormulas[r] || [];
    for (let c = 0; c < Math.max(row.length, frow.length); c++) {
      const val = String(row[c]  || '');
      const fml = String(frow[c] || '');
      const isErr = val.includes('#ERROR') || val.includes('#DIV') || val.includes('#VALUE');
      if (!isErr || !fml.startsWith('=')) continue;

      // Fix: convert comma separator to semicolon in IFERROR
      let fixed = fml.replace(/=IFERROR\((.+),\s*""\s*\)$/s, '=IFERROR($1;"")');
      fixed = fixed.replace(/=IFERROR\((.+),\s*0\s*\)$/s, '=IFERROR($1;0)');

      if (fixed !== fml) {
        function colToLetter(col) {
          let letter = ''; col += 1;
          while (col > 0) { const rem = (col-1)%26; letter = String.fromCharCode(65+rem)+letter; col = Math.floor((col-1)/26); }
          return letter;
        }
        const cellRef = "'"+sheetName+"'!"+colToLetter(c)+(r+1);
        sheetFixes.push({ range: cellRef, values: [[fixed]] });
      }
    }
  }

  if (sheetFixes.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: sheetFixes },
    });
    console.log('  ✅ '+sheetName+': исправлено '+sheetFixes.length+' (запятая→точка с запятой)');
    totalFixed += sheetFixes.length;
  }
}
if (totalFixed === 0) console.log('  Всё ок, нет формул с ошибкой разделителя.');
console.log('\n✅ Готово!');
