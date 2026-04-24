#!/usr/bin/env node
/**
 * fix-errors.js
 * Находит ячейки с #DIV/0!, #VALUE!, #ERROR! в Google Sheets
 * и оборачивает их формулы в IFERROR(..., "")
 * Не трогает ничего кроме ячеек с ошибками.
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = resolve(__dirname, '../sheets-token.json');
const ENV_PATH   = resolve(__dirname, '../.env');
const SHEET_ID   = '1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g';

// Load env
const envContent = readFileSync(ENV_PATH, 'utf-8');
for (const line of envContent.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const idx = t.indexOf('=');
  if (idx === -1) continue;
  const key = t.slice(0, idx).trim();
  const value = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  if (!process.env[key]) process.env[key] = value;
}

const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');

// Load token
const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
oauth2.setCredentials(tokens);
oauth2.on('tokens', (t) => {
  if (t.refresh_token) tokens.refresh_token = t.refresh_token;
  tokens.access_token = t.access_token;
  tokens.expiry_date  = t.expiry_date;
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
});

const sheets = google.sheets({ version: 'v4', auth: oauth2 });

async function fixErrors() {
  // 1. Get all sheet names
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
  const sheetList = meta.data.sheets.map(s => s.properties.title);
  console.log('Листы:', sheetList.join(', '));

  let totalFixed = 0;

  for (const sheetName of sheetList) {
    // Skip instruction sheet
    if (sheetName.includes('Инструкция')) continue;

    // 2. Read the entire sheet with formulas
    let formulaRes;
    try {
      formulaRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${sheetName}'`,
        valueRenderOption: 'FORMULA',
      });
    } catch (e) {
      console.log(`  ⚠️ Пропускаю ${sheetName}: ${e.message}`);
      continue;
    }

    // 3. Read values to find which cells have errors
    const valueRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${sheetName}'`,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const formulas = formulaRes.data.values || [];
    const values   = valueRes.data.values   || [];

    const updates = [];
    const errorPatterns = ['#DIV/0!', '#VALUE!', '#ERROR!', '#REF!', '#N/A', '#NAME?'];

    for (let r = 0; r < values.length; r++) {
      const row = values[r] || [];
      for (let c = 0; c < row.length; c++) {
        const cellValue = String(row[c] || '');
        const isError   = errorPatterns.some(p => cellValue.includes(p));
        if (!isError) continue;

        const formula = (formulas[r] || [])[c];
        if (!formula) continue;

        // Already wrapped in IFERROR — skip
        if (String(formula).trim().toUpperCase().startsWith('=IFERROR(')) continue;

        // Wrap in IFERROR
        const fixed = formula.startsWith('=')
          ? `=IFERROR(${formula.slice(1)},"")`
          : formula;

        // Convert row/col to A1 notation
        const colLetter = colToLetter(c);
        const cellRef   = `'${sheetName}'!${colLetter}${r + 1}`;

        updates.push({ range: cellRef, values: [[fixed]] });
        console.log(`  🔧 ${cellRef}: ${formula} → ${fixed}`);
        totalFixed++;
      }
    }

    if (updates.length === 0) {
      console.log(`  ✅ ${sheetName}: ошибок нет`);
      continue;
    }

    // 4. Batch update all fixed cells
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates,
      },
    });
    console.log(`  ✅ ${sheetName}: исправлено ${updates.length} ячеек`);
  }

  console.log(`\n✅ Готово! Всего исправлено: ${totalFixed} ячеек`);
}

function colToLetter(col) {
  let letter = '';
  col += 1;
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

fixErrors().catch(e => {
  console.error('❌ Ошибка:', e.message);
  process.exit(1);
});
