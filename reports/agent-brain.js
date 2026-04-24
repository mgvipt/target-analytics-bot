/**
 * agent-brain.js
 *
 * Мозг маркетинг-агента: SQLite база знаний + RAG для Claude.
 * Каждая группа работает в своём контексте (отдельный профиль).
 * Агент накапливает инсайты из реальных данных и маркетинговых знаний.
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, '../data/brain.db');

// Создаём папку если нет
mkdirSync(resolve(__dirname, '../data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');  // лучше для concurrent reads
db.pragma('foreign_keys = ON');

// ── Схема БД ──────────────────────────────────────────────────
db.exec(`
  -- Профили групп/подрядчиков
  CREATE TABLE IF NOT EXISTS groups (
    chat_id     TEXT PRIMARY KEY,
    name        TEXT,
    niche       TEXT,          -- декор, одежда, услуги...
    product     TEXT,          -- что продаёт
    audience    TEXT,          -- описание ЦА
    budget_usd  REAL,          -- средний месячный бюджет
    goals       TEXT,          -- KPI: лиды, продажи, охват
    context     TEXT,          -- любые доп. заметки
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  -- История кампаний с метриками
  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,
    date        TEXT,          -- YYYY-MM-DD
    campaign_id TEXT,
    name        TEXT,
    objective   TEXT,
    spend       REAL,
    impressions INTEGER,
    reach       INTEGER,
    clicks      INTEGER,
    ctr         REAL,
    cpm         REAL,
    cpc         REAL,
    results     INTEGER,
    cpl         REAL,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Накопленные инсайты (учится со временем)
  CREATE TABLE IF NOT EXISTS insights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,          -- NULL = глобальный инсайт
    category    TEXT,          -- ctr, audience, creative, funnel, budget...
    insight     TEXT,          -- сам инсайт текстом
    confidence  REAL DEFAULT 0.5,  -- 0..1, растёт при подтверждении
    source      TEXT,          -- 'auto' | 'manual' | 'feedback'
    helpful_cnt INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  -- База маркетинговых знаний (статичная + пополняемая)
  CREATE TABLE IF NOT EXISTS knowledge (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT,          -- воронки, таргетинг, креативы, текст...
    subtopic    TEXT,
    content     TEXT,          -- знание
    niche_tags  TEXT,          -- 'декор,интерьер,b2c' или 'universal'
    priority    INTEGER DEFAULT 5,  -- 1-10
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- История рекомендаций и обратная связь
  CREATE TABLE IF NOT EXISTS recommendations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,
    context     TEXT,          -- при каком вопросе
    recommendation TEXT,
    outcome     TEXT,          -- 'helpful' | 'not_helpful' | 'unknown'
    metric_before TEXT,        -- CTR/CPL до
    metric_after  TEXT,        -- CTR/CPL после (если замерили)
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- История диалогов (краткая, для контекста)
  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,
    role        TEXT,          -- 'user' | 'assistant'
    message     TEXT,
    summary     TEXT,          -- краткое резюме длинных сообщений
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Еженедельные итоги
  CREATE TABLE IF NOT EXISTS weekly_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,
    week_start  TEXT,
    total_spend REAL,
    avg_ctr     REAL,
    avg_cpl     REAL,
    best_campaign TEXT,
    worst_campaign TEXT,
    key_insight TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ── API для работы с группами ─────────────────────────────────

export function getGroup(chatId) {
  return db.prepare('SELECT * FROM groups WHERE chat_id = ?').get(String(chatId));
}

export function upsertGroup(chatId, fields) {
  const existing = getGroup(chatId);
  if (existing) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE groups SET ${sets}, updated_at = datetime('now') WHERE chat_id = ?`)
      .run(...Object.values(fields), String(chatId));
  } else {
    const keys   = ['chat_id', ...Object.keys(fields)];
    const vals   = [String(chatId), ...Object.values(fields)];
    const placeholders = keys.map(() => '?').join(', ');
    db.prepare(`INSERT INTO groups (${keys.join(', ')}) VALUES (${placeholders})`)
      .run(...vals);
  }
}

// ── API для кампаний ──────────────────────────────────────────

export function saveCampaignMetrics(chatId, date, metrics) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO campaigns
      (chat_id, date, campaign_id, name, objective, spend, impressions, reach,
       clicks, ctr, cpm, cpc, results, cpl)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const m of metrics) {
    stmt.run(
      String(chatId), date,
      m.campaign_id || '', m.name || '', m.objective || '',
      m.spend || 0, m.impressions || 0, m.reach || 0,
      m.clicks || 0, m.ctr || 0, m.cpm || 0, m.cpc || 0,
      m.results || 0, m.cpl || 0
    );
  }
}

export function getRecentCampaigns(chatId, days = 30) {
  return db.prepare(`
    SELECT * FROM campaigns
    WHERE chat_id = ? AND date >= date('now', '-${days} days')
    ORDER BY date DESC
  `).all(String(chatId));
}

export function getCampaignTrend(chatId) {
  return db.prepare(`
    SELECT
      date,
      SUM(spend) as spend,
      AVG(ctr) as avg_ctr,
      AVG(cpl) as avg_cpl,
      SUM(results) as results
    FROM campaigns
    WHERE chat_id = ?
    GROUP BY date
    ORDER BY date DESC
    LIMIT 14
  `).all(String(chatId));
}

// ── API для инсайтов ──────────────────────────────────────────

export function addInsight(chatId, category, insight, source = 'auto') {
  // Проверяем нет ли похожего
  const similar = db.prepare(`
    SELECT id FROM insights
    WHERE (chat_id = ? OR chat_id IS NULL)
    AND category = ?
    AND insight LIKE ?
  `).get(String(chatId), category, `%${insight.slice(0, 30)}%`);

  if (similar) {
    // Повышаем confidence
    db.prepare(`
      UPDATE insights SET confidence = MIN(1.0, confidence + 0.1),
      helpful_cnt = helpful_cnt + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(similar.id);
    return similar.id;
  }

  const result = db.prepare(`
    INSERT INTO insights (chat_id, category, insight, source)
    VALUES (?, ?, ?, ?)
  `).run(chatId ? String(chatId) : null, category, insight, source);
  return result.lastInsertRowid;
}

export function getInsights(chatId, category = null, limit = 10) {
  const cond = category ? 'AND category = ?' : '';
  const args = category
    ? [String(chatId), String(chatId), category, limit]
    : [String(chatId), String(chatId), limit];
  return db.prepare(`
    SELECT * FROM insights
    WHERE (chat_id = ? OR chat_id IS NULL)
    ${cond}
    ORDER BY confidence DESC, helpful_cnt DESC
    LIMIT ?
  `).all(...args);
}

export function markInsightHelpful(insightId, helpful = true) {
  db.prepare(`
    UPDATE insights SET
      helpful_cnt = helpful_cnt + ?,
      confidence  = MIN(1.0, MAX(0.0, confidence + ?)),
      updated_at  = datetime('now')
    WHERE id = ?
  `).run(helpful ? 1 : 0, helpful ? 0.15 : -0.2, insightId);
}

// ── API для базы знаний ───────────────────────────────────────

export function addKnowledge(topic, subtopic, content, nicheTags = 'universal', priority = 5) {
  return db.prepare(`
    INSERT INTO knowledge (topic, subtopic, content, niche_tags, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(topic, subtopic, content, nicheTags, priority);
}

export function searchKnowledge(query, niche = null, limit = 5) {
  const nicheFilter = niche
    ? `AND (niche_tags LIKE '%${niche}%' OR niche_tags = 'universal')`
    : '';
  return db.prepare(`
    SELECT * FROM knowledge
    WHERE content LIKE ? ${nicheFilter}
    ORDER BY priority DESC
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function getKnowledgeByTopic(topic, niche = null, limit = 8) {
  const nicheFilter = niche
    ? `AND (niche_tags LIKE '%${niche}%' OR niche_tags = 'universal')`
    : '';
  return db.prepare(`
    SELECT * FROM knowledge
    WHERE topic = ? ${nicheFilter}
    ORDER BY priority DESC
    LIMIT ?
  `).all(topic, limit);
}

// ── История диалогов ──────────────────────────────────────────

export function saveMessage(chatId, role, message) {
  const summary = message.length > 300 ? message.slice(0, 300) + '...' : null;
  db.prepare(`
    INSERT INTO conversations (chat_id, role, message, summary)
    VALUES (?, ?, ?, ?)
  `).run(String(chatId), role, message, summary);

  // Храним последние 50 сообщений на группу
  db.prepare(`
    DELETE FROM conversations WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM conversations WHERE chat_id = ? ORDER BY id DESC LIMIT 50
    )
  `).run(String(chatId), String(chatId));
}

export function getRecentHistory(chatId, limit = 10) {
  return db.prepare(`
    SELECT role, COALESCE(summary, message) as message, created_at
    FROM conversations WHERE chat_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(String(chatId), limit).reverse();
}

// ── Сохранить рекомендацию ────────────────────────────────────

export function saveRecommendation(chatId, context, recommendation) {
  const result = db.prepare(`
    INSERT INTO recommendations (chat_id, context, recommendation)
    VALUES (?, ?, ?)
  `).run(String(chatId), context, recommendation);
  return result.lastInsertRowid;
}

export function markRecommendation(recId, outcome) {
  db.prepare(`UPDATE recommendations SET outcome = ? WHERE id = ?`).run(outcome, recId);
}

// ── Строим контекст для Claude (RAG) ─────────────────────────

export function buildContext(chatId, userQuestion) {
  const group    = getGroup(chatId);
  const insights = getInsights(chatId, null, 8);
  const trend    = getCampaignTrend(chatId);
  const history  = getRecentHistory(chatId, 8);

  // Ищем релевантные знания по ключевым словам из вопроса
  const keywords = userQuestion.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4).slice(0, 3);
  const relevant = keywords.flatMap(kw =>
    searchKnowledge(kw, group?.niche, 3)
  );
  const uniqueKnowledge = [...new Map(relevant.map(k => [k.id, k])).values()].slice(0, 6);

  let ctx = '';

  // Профиль группы
  if (group) {
    ctx += `## Профиль клиента\n`;
    if (group.name)     ctx += `Имя/группа: ${group.name}\n`;
    if (group.niche)    ctx += `Ниша: ${group.niche}\n`;
    if (group.product)  ctx += `Продукт: ${group.product}\n`;
    if (group.audience) ctx += `ЦА: ${group.audience}\n`;
    if (group.goals)    ctx += `Цели: ${group.goals}\n`;
    if (group.context)  ctx += `Доп. контекст: ${group.context}\n`;
    ctx += '\n';
  }

  // Тренд последних 7 дней
  if (trend.length > 0) {
    const last7 = trend.slice(0, 7);
    const avgCtr = (last7.reduce((s, r) => s + (r.avg_ctr || 0), 0) / last7.length).toFixed(2);
    const avgCpl = (last7.reduce((s, r) => s + (r.avg_cpl || 0), 0) / last7.length).toFixed(2);
    const totalSpend = last7.reduce((s, r) => s + (r.spend || 0), 0).toFixed(2);
    ctx += `## Данные за последние 7 дней\n`;
    ctx += `Расход: $${totalSpend} | Средний CTR: ${avgCtr}% | Средний CPL: $${avgCpl}\n\n`;
  }

  // Накопленные инсайты
  if (insights.length > 0) {
    ctx += `## Накопленные инсайты по этому клиенту\n`;
    insights.forEach(i => {
      const conf = i.confidence >= 0.7 ? '✅' : i.confidence >= 0.4 ? '🟡' : '⚪';
      ctx += `${conf} [${i.category}] ${i.insight}\n`;
    });
    ctx += '\n';
  }

  // Релевантные знания из базы
  if (uniqueKnowledge.length > 0) {
    ctx += `## Релевантные маркетинговые знания\n`;
    uniqueKnowledge.forEach(k => {
      ctx += `[${k.topic}/${k.subtopic}] ${k.content}\n`;
    });
    ctx += '\n';
  }

  return { ctx, history };
}

// ── Автоанализ после утреннего отчёта ─────────────────────────

export function autoAnalyze(chatId, todayMetrics) {
  const trend = getCampaignTrend(chatId);
  if (trend.length < 3) return; // мало данных

  const today = todayMetrics;
  const prev7 = trend.slice(0, 7);
  const avgCtr = prev7.reduce((s, r) => s + (r.avg_ctr || 0), 0) / prev7.length;
  const avgCpl = prev7.reduce((s, r) => s + (r.avg_cpl || 0), 0) / prev7.length;

  // Авто-инсайты
  if (today.ctr > avgCtr * 1.3) {
    addInsight(chatId, 'ctr',
      `${today.date}: CTR ${today.ctr.toFixed(2)}% — на 30%+ выше среднего (${avgCtr.toFixed(2)}%)`,
      'auto'
    );
  }
  if (today.ctr < avgCtr * 0.6 && today.spend > 5) {
    addInsight(chatId, 'ctr',
      `${today.date}: CTR упал до ${today.ctr.toFixed(2)}% при расходе $${today.spend.toFixed(0)} — возможно выгорание аудитории`,
      'auto'
    );
  }
  if (today.cpl > 0 && avgCpl > 0 && today.cpl < avgCpl * 0.8) {
    addInsight(chatId, 'cpl',
      `${today.date}: CPL $${today.cpl.toFixed(2)} — на 20%+ лучше среднего ($${avgCpl.toFixed(2)})`,
      'auto'
    );
  }
}

// ── Статистика мозга ──────────────────────────────────────────

export function getBrainStats() {
  return {
    groups:      db.prepare('SELECT COUNT(*) as n FROM groups').get().n,
    campaigns:   db.prepare('SELECT COUNT(*) as n FROM campaigns').get().n,
    insights:    db.prepare('SELECT COUNT(*) as n FROM insights').get().n,
    knowledge:   db.prepare('SELECT COUNT(*) as n FROM knowledge').get().n,
    conversations: db.prepare('SELECT COUNT(*) as n FROM conversations').get().n,
  };
}

export { db };
