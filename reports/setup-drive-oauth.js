#!/usr/bin/env node
/**
 * setup-drive-oauth.js
 * One-time OAuth2 setup for Google Drive uploads.
 * Run: node reports/setup-drive-oauth.js
 *
 * Saves refresh token to .env so future uploads work automatically.
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '../.env');
const TOKEN_PATH = resolve(__dirname, '../drive-token.json');

// Load .env
function loadEnv() {
  try {
    const content = readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      const key = t.slice(0, idx).trim();
      const value = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

function appendToEnv(key, value) {
  let content = '';
  try { content = readFileSync(ENV_PATH, 'utf-8'); } catch {}
  // Remove existing key if present
  const lines = content.split('\n').filter(l => !l.startsWith(key + '='));
  lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join('\n'));
  console.log(`✅ Saved ${key} to .env`);
}

loadEnv();

const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log(`
❌ OAuth2 credentials not found in .env

Нужно один раз создать OAuth2 credentials в Google Cloud Console:

1. Открой: https://console.cloud.google.com/apis/credentials?project=ads-analytics-492919
2. Нажми "+ CREATE CREDENTIALS" → "OAuth client ID"
3. Application type: "Desktop app"
4. Name: "Wallcov Bot" → нажми "Create"
5. Скопируй Client ID и Client Secret из появившегося окна
6. Добавь их в .env:

   GOOGLE_OAUTH_CLIENT_ID=ваш_client_id
   GOOGLE_OAUTH_CLIENT_SECRET=ваш_client_secret

7. Запусти этот скрипт снова: node reports/setup-drive-oauth.js
`);
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob' // Desktop app redirect
);

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log(`
🔗 Открой эту ссылку в браузере и авторизуй доступ:

${authUrl}

После авторизации Google покажет код — скопируй его и вставь сюда.
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Введи код: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    oauth2Client.setCredentials(tokens);

    // Save tokens to file
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('\n✅ Токен сохранён в drive-token.json');

    // Update .env with token path
    appendToEnv('GOOGLE_DRIVE_TOKEN_FILE', TOKEN_PATH);

    // Test it works
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const about = await drive.about.get({ fields: 'user,storageQuota' });
    console.log(`\n✅ Авторизован как: ${about.data.user.emailAddress}`);
    const quota = about.data.storageQuota;
    const used = Math.round(parseInt(quota.usage || 0) / 1024 / 1024 / 1024 * 10) / 10;
    const total = parseInt(quota.limit || 0) > 0 ? Math.round(parseInt(quota.limit) / 1024 / 1024 / 1024) + 'GB' : 'unlimited';
    console.log(`📊 Storage: ${used}GB / ${total} использовано`);
    console.log('\n🎉 Google Drive готов! Теперь кнопка "☁️ На Диск" будет работать.');

  } catch (e) {
    console.error('❌ Ошибка авторизации:', e.message);
    process.exit(1);
  }
});
