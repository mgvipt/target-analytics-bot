/**
 * drive-upload.js — Google Drive integration
 * Creates folder structure: Отчеты → [Month] → [date]-analytics.docx / [date]-recommendations.docx
 * Returns shareable links for Telegram messages.
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync, createReadStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env if not already loaded
try {
  const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const value = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

const CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE
  || resolve(__dirname, '../../ads-analytics-492919-f04dc30be6d7.json');

// Folder ID of "Статистика таргет" on Google Drive
const STAT_FOLDER_ID = process.env.DRIVE_STAT_FOLDER_ID || null;

function getAuth() {
  // Prefer OAuth2 user token (no quota issues) over service account
  const tokenFile = process.env.GOOGLE_DRIVE_TOKEN_FILE;
  if (tokenFile) {
    try {
      const tokens = JSON.parse(readFileSync(tokenFile, 'utf-8'));
      const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      if (clientId && clientSecret) {
        const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
        oauth2.setCredentials(tokens);
        // Auto-refresh token if needed
        oauth2.on('tokens', (newTokens) => {
          if (newTokens.refresh_token) tokens.refresh_token = newTokens.refresh_token;
          tokens.access_token  = newTokens.access_token;
          tokens.expiry_date   = newTokens.expiry_date;
          try { writeFileSync(tokenFile, JSON.stringify(tokens, null, 2)); } catch {}
        });
        return oauth2;
      }
    } catch {}
  }
  // Fallback: service account (can only work with Shared Drives)
  return new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_FILE,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

/**
 * Find or create a subfolder by name inside parentId
 */
async function getOrCreateFolder(drive, name, parentId) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 5 });
  if (res.data.files?.length > 0) {
    return res.data.files[0].id;
  }

  // Create it
  const createParams = {
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  };
  const created = await drive.files.create(createParams);
  return created.data.id;
}

/**
 * Make file/folder publicly readable and return shareable link
 */
async function makePublic(drive, fileId) {
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  const file = await drive.files.get({ fileId, fields: 'webViewLink' });
  return file.data.webViewLink;
}

/**
 * Upload a .docx file to Google Drive inside the correct month folder.
 * Pass existingMonthFolder to reuse an already-created folder (avoids duplicate folders
 * when uploading multiple files sequentially).
 * Returns { fileId, fileLink, folderLink, monthFolder }
 */
export async function uploadReport(filePath, filename, existingMonthFolder = null) {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  let monthFolder;

  if (existingMonthFolder) {
    // Reuse the folder ID created by the first upload — no extra API calls
    monthFolder = existingMonthFolder;
  } else {
    // Month folder name: "Апрель 2026"
    const now = new Date();
    const monthName = now.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    const monthCapitalized = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    let reportsFolder;
    if (STAT_FOLDER_ID) {
      // Full structure: Статистика таргета / Отчёты / Апрель 2026
      reportsFolder = await getOrCreateFolder(drive, 'Отчёты', STAT_FOLDER_ID);
    } else {
      reportsFolder = await getOrCreateFolder(drive, 'Отчёты Wallcov', null);
    }
    monthFolder = await getOrCreateFolder(drive, monthCapitalized, reportsFolder);
  }

  // Upload .docx as-is (no conversion) — preserves exact column widths and formatting.
  // OAuth2 user account has sufficient quota; conversion to Google Doc breaks table widths.
  const fileStream = createReadStream(filePath);
  const uploadRes = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [monthFolder],
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: fileStream,
    },
    fields: 'id,name,webViewLink',
  });

  const fileId = uploadRes.data.id;

  // Make public (anyone with link can view)
  const fileLink = await makePublic(drive, fileId);
  const folderLink = `https://drive.google.com/drive/folders/${monthFolder}`;

  return { fileId, fileLink, folderLink, monthFolder };
}

/**
 * Helper: find the "Статистика таргета" folder ID
 * Run once after sharing the folder with the service account
 */
export async function findStatFolder() {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id,name,parents)',
    pageSize: 100,
  });
  console.log('Folders visible to service account:');
  for (const f of res.data.files || []) {
    console.log(`  "${f.name}" — ID: ${f.id}`);
  }
  return res.data.files;
}

