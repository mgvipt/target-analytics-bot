import { google } from 'googleapis';
import { readFileSync } from 'fs';
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

const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');
const tokens = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
oauth2.setCredentials(tokens);
const sheets = google.sheets({ version: 'v4', auth: oauth2 });

const [fRes, vRes] = await Promise.all([
  sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Апрель 2026'", valueRenderOption: 'FORMULA' }),
  sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Апрель 2026'", valueRenderOption: 'FORMATTED_VALUE' }),
]);

const formulas = fRes.data.values || [];
const values   = vRes.data.values || [];

console.log('=== Апрель 2026: строки с содержимым ===');
for (let r = 0; r < Math.min(values.length, 120); r++) {
  const row  = values[r]   || [];
  const frow = formulas[r] || [];
  const ncols = Math.max(row.length, frow.length);
  const label = row[0] || frow[0] || '';
  // Show label + last filled column
  const lastVal = row[ncols-1] || '';
  const lastFml = String(frow[ncols-1] || '').slice(0, 100);
  if (label || lastVal) {
    console.log('R'+(r+1)+' col'+ncols+': "'+label+'" | val="'+lastVal+'" | formula="'+lastFml+'"');
  }
}
