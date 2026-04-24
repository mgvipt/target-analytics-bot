import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

export const META_TOKEN = process.env.META_ACCESS_TOKEN;
export const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
export const IG_ID      = process.env.META_IG_ACCOUNT_ID;
export const PAGE_ID    = process.env.META_PAGE_ID;
export const API_VERSION = process.env.META_API_VERSION || 'v21.0';
export const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
export const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// Thresholds for alerts
export const THRESHOLDS = {
  CTR_LOW: 1.0,         // % — ниже этого = 🔴
  CTR_WARN: 2.0,        // % — ниже этого = 🟡
  CPM_SPIKE: 30,        // % роста CPM за день = 🟠
  FREQUENCY_WARN: 2.0,  // частота показов = 🟡
  FREQUENCY_HIGH: 3.0,  // частота показов = 🔴
  LEARNING_DAYS: 7,     // дней до конца фазы обучения
  UNDERSPEND: 0.7,      // 70% бюджета — недорасход
};
