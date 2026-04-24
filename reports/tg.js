import { TG_TOKEN, TG_CHAT } from './config.js';

export async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

export function fmt(n, decimals = 2) {
  return parseFloat(n || 0).toFixed(decimals);
}

export function fmtMoney(n) {
  return `$${fmt(n)}`;
}

export function getDaysSince(dateStr) {
  const start = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

export function isLearning(startTime) {
  return getDaysSince(startTime) < 7;
}

export function parseActions(actions = []) {
  const result = {};
  for (const a of actions) result[a.action_type] = parseFloat(a.value) || 0;
  return result;
}
