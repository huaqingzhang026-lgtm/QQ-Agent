// 统一时间线记忆：SQLite（Node 内置 node:sqlite）。
// 只追加事件，不覆盖历史；人物/关系/平台内容都可回溯。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DEFAULT_DB = path.join(ROOT, 'qq-bridge', 'state', 'memory.sqlite');
let db = null;

function now() { return Date.now(); }
function safeJson(v) { try { return JSON.stringify(v ?? null); } catch { return 'null'; } }
function normalizeText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

export function openMemory(file = DEFAULT_DB) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      conversation_key TEXT,
      actor_id TEXT,
      actor_name TEXT,
      kind TEXT,
      text TEXT NOT NULL,
      source_ref TEXT,
      importance REAL DEFAULT 0.5,
      confidence REAL DEFAULT 0.6,
      meta_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ref ON events(source, source_ref) WHERE source_ref IS NOT NULL AND source_ref <> '';
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id, occurred_at);
    CREATE TABLE IF NOT EXISTS event_vectors (
      event_id INTEGER PRIMARY KEY,
      vector_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS people (
      qq TEXT PRIMARY KEY,
      names_json TEXT,
      summary TEXT,
      last_seen_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS relationships (
      subject TEXT NOT NULL,
      object TEXT NOT NULL,
      kind TEXT,
      score REAL DEFAULT 0,
      summary TEXT,
      updated_at INTEGER,
      PRIMARY KEY(subject, object)
    );
    CREATE TABLE IF NOT EXISTS platform_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT,
      url TEXT,
      summary TEXT,
      occurred_at INTEGER,
      meta_json TEXT,
      UNIQUE(platform, item_id)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      subject TEXT,
      scope TEXT,
      text TEXT NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      source TEXT,
      confidence REAL DEFAULT 0.6,
      status TEXT DEFAULT 'active',
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      trigger TEXT,
      response TEXT,
      strength REAL DEFAULT 0,
      reinforced_at INTEGER,
      status TEXT DEFAULT 'active',
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT,
      evidence_json TEXT,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      completed_at INTEGER,
      due_at INTEGER,
      updated_at INTEGER NOT NULL,
      reason TEXT,
      source_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_status ON commitments(scope, status, updated_at);
  `);
  // 兼容旧库：只加列，不删旧记忆。
  try { db.exec('ALTER TABLE memories ADD COLUMN superseded_by INTEGER'); } catch {}
  // A05：平台内容补 scope；旧行默认 shared，检索时仍受 allowedScopes 约束。
  try { db.exec("ALTER TABLE platform_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'"); } catch {}
  // A05-rework1：人物摘要/关系摘要补来源 scope；旧行 NULL 表示来源未知，保守不展示。
  try { db.exec('ALTER TABLE people ADD COLUMN summary_scope TEXT'); } catch {}
  try { db.exec('ALTER TABLE relationships ADD COLUMN scope TEXT'); } catch {}
  // A05-rework1：承诺身份与证据链字段。identity 是唯一业务身份，由调用方计算。
  for (const col of ['identity','request_ref','request_message_id','decision_id','execution_id','message_text','send_ref','fulfillment_ref','fulfillment_tool','fulfillment_action','completion_type','completion_condition_json']) {
    try { db.exec(`ALTER TABLE commitments ADD COLUMN ${col} TEXT`); } catch {}
  }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_identity ON commitments(identity)'); } catch {}
  return db;
}

function hashVector(text, dims = 96) {
  const v = new Array(dims).fill(0);
  const s = String(text || '').toLowerCase();
  const tokens = s.match(/[\p{Script=Han}]{1,3}|[a-z0-9_]{2,}/gu) || [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dims] += 1;
  }
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => +(x / norm).toFixed(4));
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] * b[i];
  return n;
}

export function addEvent({
  occurredAt = now(), source = 'unknown', conversationKey = null, actorId = null,
  actorName = '', kind = 'message', text = '', sourceRef = null,
  importance = 0.5, confidence = 0.6, meta = null,
} = {}) {
  const body = normalizeText(text);
  if (!body) return null;
  const d = openMemory();
  const at = Number(occurredAt) || now();
  try {
    const r = d.prepare(`INSERT OR IGNORE INTO events
      (occurred_at, recorded_at, source, conversation_key, actor_id, actor_name, kind, text, source_ref, importance, confidence, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(at, now(), String(source), conversationKey, actorId == null ? null : String(actorId), String(actorName || ''), String(kind), body, sourceRef == null ? null : String(sourceRef), Number(importance) || 0.5, Number(confidence) || 0.6, safeJson(meta));
    if (r.changes > 0) {
      const id = Number(r.lastInsertRowid);
      d.prepare('INSERT INTO events_fts(rowid, text) VALUES (?, ?)').run(id, body);
      try { d.prepare('INSERT OR REPLACE INTO event_vectors (event_id, vector_json) VALUES (?, ?)').run(id, JSON.stringify(hashVector(body))); } catch {}
      return id;
    }
  } catch (e) {
    console.error('[memory] addEvent 失败:', e?.message ?? e);
  }
  return null;
}

export function upsertPerson({ qq, names = {}, summary = '', summaryScope = null, lastSeenAt = now() } = {}) {
  if (!qq) return;
  const d = openMemory();
  const scope = summaryScope == null ? null : String(summaryScope);
  d.prepare(`INSERT INTO people (qq, names_json, summary, summary_scope, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(qq) DO UPDATE SET
      names_json=excluded.names_json,
      summary=COALESCE(NULLIF(excluded.summary,''), people.summary),
      summary_scope=COALESCE(excluded.summary_scope, people.summary_scope),
      last_seen_at=MAX(COALESCE(people.last_seen_at,0), excluded.last_seen_at), updated_at=excluded.updated_at`)
    .run(String(qq), safeJson(names), String(summary || ''), scope, Number(lastSeenAt) || now(), now());
}

export function mergePersonNames({ qq, names = {}, lastSeenAt = now() } = {}) {
  if (!qq) return;
  const d = openMemory();
  try {
    const old = d.prepare('SELECT names_json FROM people WHERE qq=?').get(String(qq));
    let base = {}; try { base = JSON.parse(old?.names_json || '{}'); } catch {}
    const merged = { ...base, ...(names || {}) };
    d.prepare(`INSERT INTO people (qq, names_json, summary, last_seen_at, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(qq) DO UPDATE SET names_json=excluded.names_json, last_seen_at=MAX(COALESCE(people.last_seen_at,0),excluded.last_seen_at), updated_at=excluded.updated_at`)
      .run(String(qq), safeJson(merged), '', Number(lastSeenAt) || now(), now());
  } catch {}
}

export function addPlatformItem({ platform, itemId, title = '', url = '', summary = '', occurredAt = now(), meta = null, scope = 'shared' } = {}) {
  if (!platform || !itemId) return;
  const d = openMemory();
  d.prepare(`INSERT INTO platform_items (platform, item_id, title, url, summary, occurred_at, meta_json, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, item_id) DO UPDATE SET title=excluded.title, url=excluded.url, summary=excluded.summary, occurred_at=excluded.occurred_at, meta_json=excluded.meta_json, scope=excluded.scope`)
    .run(String(platform), String(itemId), String(title || ''), String(url || ''), String(summary || ''), Number(occurredAt) || now(), safeJson(meta), String(scope || 'shared'));
}

export function addMemory({ type = 'event', subject = '', scope = '', text = '', validFrom = now(), validTo = null, source = '', confidence = 0.6, status = 'active' } = {}) {
  if (!normalizeText(text)) return;
  const d = openMemory();
  d.prepare(`INSERT INTO memories (type, subject, scope, text, valid_from, valid_to, source, confidence, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(type), String(subject), String(scope), normalizeText(text), Number(validFrom) || now(), validTo == null ? null : Number(validTo), String(source), Number(confidence) || 0.6, String(status), now(), now());
}

/** A05：scope 过滤只接受非空数组；空数组/缺失都不是“全部”。 */
export function scopeFilterSql(scopes, column = 'conversation_key') {
  const list = (Array.isArray(scopes) ? scopes : []).map(String).filter(Boolean);
  if (!list.length) return { sql: '1=0', args: [] };
  return { sql: `${column} IN (${list.map(() => '?').join(',')})`, args: list };
}

export function hybridSearch(query, limit = 5, { scopes = [] } = {}) {
  const cap = Math.max(1, Math.min(20, Number(limit) || 5));
  const byId = new Map();
  const add = (row, matchedBy, score, priority) => {
    if (!row?.id) return;
    const old = byId.get(row.id);
    if (!old) byId.set(row.id, { ...row, matchedBy: [matchedBy], score, sourcePriority: priority });
    else {
      old.matchedBy = [...new Set([...(old.matchedBy ?? []), matchedBy])];
      old.score = Math.max(Number(old.score) || 0, score);
      old.sourcePriority = Math.max(Number(old.sourcePriority) || 0, priority);
    }
  };
  // 相关候选有独立预算；时间线只补余量，不能挤掉明确命中。
  const relevantBudget = Math.max(1, Math.ceil(cap * 0.75));
  const timelineBudget = Math.max(0, cap - relevantBudget);
  const relevant = searchEvents(query, relevantBudget, { scopes });
  for (const e of relevant) {
    const ageDays = Math.max(0, (now() - Number(e.occurred_at || 0)) / 86400000);
    const recency = Math.max(0, 1 - ageDays / 90);
    add(e, 'fts', Math.round((0.85 + recency * 0.15) * 1000) / 1000, 2);
  }
  const recent = recentEvents({ scopes, limit: Math.max(timelineBudget * 6, 12) });
  let timelineAdded = 0;
  for (const e of recent) {
    if (timelineAdded >= timelineBudget) break;
    if (byId.has(e.id)) continue;
    const ageDays = Math.max(0, (now() - Number(e.occurred_at || 0)) / 86400000);
    const recency = Math.max(0, 1 - ageDays / 30);
    if (recency <= 0.05) continue;
    add(e, 'timeline', Math.round(recency * 1000) / 1000, 1);
    timelineAdded += 1;
  }
  const qv = hashVector(query);
  for (const row of byId.values()) {
    try { row.vectorScore = cosine(qv, JSON.parse(row.vector_json || '[]')); } catch { row.vectorScore = 0; }
  }
  // 稳定排序：sourcePriority -> score -> occurred_at -> id。
  return [...byId.values()]
    .map((row) => ({ ...row, score: Math.round((Number(row.score) || 0) * 1000) / 1000 }))
    .filter((row) => row.score > 0.05)
    .sort((a, b) => ((b.sourcePriority || 0) - (a.sourcePriority || 0))
      || (b.score - a.score)
      || (Number(b.occurred_at || 0) - Number(a.occurred_at || 0))
      || (Number(b.id || 0) - Number(a.id || 0)))
    .slice(0, cap);
}

function ftsQuery(q) {
  const words = String(q || '').replace(/[^\p{L}\p{N}_]+/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ');
}

export function searchEvents(query, limit = 5, { scopes = [] } = {}) {
  const d = openMemory();
  const q = ftsQuery(query);
  if (!q) return [];
  const scopeF = scopeFilterSql(scopes);
  const cap = Math.max(1, Math.min(50, Number(limit) || 5));
  try {
    const fts = d.prepare(`SELECT e.*, bm25(events_fts) AS rank FROM events_fts
      JOIN events e ON e.id = events_fts.rowid
      WHERE events_fts MATCH ? AND ${scopeF.sql}
      ORDER BY rank, e.occurred_at DESC, e.id DESC LIMIT ?`).all(q, ...scopeF.args, cap);
    if (fts.length) return fts;
  } catch {}
  // 兜底：当前 Node SQLite 的 fts5 对中文分词不稳定；用授权范围内的 LIKE 候选替代。
  // 仍保持 scope 过滤 + 时间稳定排序，且只取有界数量。
  const needle = `%${String(query).replace(/\s+/g, ' ').trim().slice(0, 120)}%`;
  try {
    const rows = d.prepare(`SELECT *, 0 AS rank FROM events
      WHERE ${scopeF.sql} AND text LIKE ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(...scopeF.args, needle, cap);
    return rows;
  } catch { return []; }
}

function fmtTime(ms) {
  try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

export function buildMemoryBrief({ key = '', actorId = null, query = '', limit = 8, scopes = [], commitments = [] } = {}) {
  const d = openMemory();
  const activeScopes = (Array.isArray(scopes) && scopes.length ? scopes : [key]).map(String).filter(Boolean);
  const scopeF = scopeFilterSql(activeScopes);
  let text = '';
  try {
    if (actorId) {
      const p = d.prepare('SELECT * FROM people WHERE qq = ?').get(String(actorId));
      if (p) {
        // 人物昵称按来源 scope 过滤；未知 scope 的昵称只在私聊可见，群聊保守排除。
        const names = (() => {
          try {
            const raw = JSON.parse(p.names_json || '{}') || {};
            return Object.entries(raw)
              .filter(([scope, name]) => name && activeScopes.includes(String(scope)))
              .map(([, name]) => String(name))
              .slice(0, 3).join(' / ');
          } catch { return ''; }
        })();
        // 摘要必须有明确来源 scope；旧行 summary_scope NULL 保守不展示。
        const summaryVisible = p.summary && p.summary_scope && (activeScopes.includes(String(p.summary_scope)) || String(p.summary_scope) === 'shared');
        if (names || summaryVisible) {
          text += `【人物】${names || actorId}${summaryVisible ? '：' + p.summary : ''}；最近出现 ${fmtTime(p.last_seen_at)}\n`;
        }
      }
      // 关系摘要也要有明确 scope；旧行 NULL 保守不展示。
      const rel = d.prepare(`SELECT * FROM relationships
        WHERE subject = ? AND object = ? AND scope IS NOT NULL
          AND (scope IN (${activeScopes.map(() => '?').join(',')}) OR scope = 'shared')`)
        .get(String(actorId), String(key), ...activeScopes);
      if (rel?.summary) text += `【关系】${rel.summary}\n`;
    }
    // 当前承诺有独立预算，不参与普通旧事截断。
    const activeCommitments = (Array.isArray(commitments) ? commitments : [])
      .filter((c) => ['active', 'proposed', 'uncertain'].includes(String(c?.status ?? '')))
      .slice(0, 3);
    if (activeCommitments.length) {
      text += '【当前承诺/未决】\n' + activeCommitments.map((c) => {
        const due = Number(c.due_at || c.dueAt || 0);
        const when = due ? `；到期 ${fmtTime(due)}` : '';
        return `- ${String(c.text).slice(0, 100)}（${c.status}${when}）`;
      }).join('\n') + '\n';
    }
    const recent = d.prepare(`SELECT * FROM events WHERE ${scopeF.sql} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
      .all(...scopeF.args, Math.max(1, Math.min(limit, 12))).reverse();
    if (recent.length) {
      text += '【最近时间线】\n' + recent.map((e) => `- ${fmtTime(e.occurred_at)} ${e.actor_name || e.actor_id || '?'}：${String(e.text).slice(0, 100)}`).join('\n') + '\n';
    }
    if (query) {
      const relevant = hybridSearch(query, 4, { scopes: activeScopes }).filter((e) => !recent.some((r) => r.id === e.id));
      if (relevant.length) {
        text += '【相关旧事】\n' + relevant.map((e) => {
          const why = (e.matchedBy ?? []).join('+');
          return `- ${fmtTime(e.occurred_at)} ${e.actor_name || '?'}：${String(e.text).slice(0, 110)}（${why}）`;
        }).join('\n') + '\n';
      }
    }
    // 平台内容也按 scope 过滤；旧行默认 shared，不会进入未授权会话。
    const platformF = scopeFilterSql(activeScopes, 'scope');
    const platforms = d.prepare(`SELECT * FROM platform_items
      WHERE (scope IS NOT NULL AND (scope IN (${activeScopes.map(() => '?').join(',')}) OR scope = 'shared'))
      ORDER BY occurred_at DESC, id DESC LIMIT 3`).all(...activeScopes);
    if (platforms.length) {
      text += '【平台内容】\n' + platforms.map((p) => `- ${p.platform} ${fmtTime(p.occurred_at)} ${String(p.title || p.summary || '').slice(0, 100)}`).join('\n') + '\n';
    }
  } catch (e) {
    console.error('[memory] brief 失败:', e?.message ?? e);
  }
  const out = text.trim();
  return out ? `【时间线记忆】\n${out.slice(0, 1800)}\n\n` : '';
}

export function listMemories(limit = 500) {
  const d = openMemory();
  try { return d.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(2000, limit))); } catch { return []; }
}

export function supersedeMemory(id, supersededBy = null, reason = 'semantic duplicate') {
  const d = openMemory();
  try {
    d.prepare("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?").run(supersededBy == null ? null : Number(supersededBy), Date.now(), Number(id));
    return true;
  } catch { return false; }
}

export function recentEvents({ since = 0, limit = 40, scopes = [] } = {}) {
  const d = openMemory();
  const scopeF = scopeFilterSql(scopes);
  try { return d.prepare(`SELECT * FROM events WHERE ${scopeF.sql} ${Number(since) > 0 ? 'AND occurred_at >= ?' : ''} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .all(...scopeF.args, ...(Number(since) > 0 ? [Number(since)] : []), Math.max(1, Math.min(200, limit))).reverse(); } catch { return []; }
}

export function decayMemories(days = 90) {
  const d = openMemory();
  try {
    const p = Math.pow(0.5, 1 / Math.max(1, Number(days)));
    d.prepare('UPDATE memories SET confidence = MAX(0.05, confidence * ?), updated_at = ? WHERE status = ?').run(p, now(), 'active');
  } catch {}
}

export function consolidateSkills() {
  const d = openMemory();
  let n = 0;
  try {
    const rows = d.prepare("SELECT text, COUNT(DISTINCT date(occurred_at/1000, 'unixepoch')) AS days, COUNT(*) AS n FROM events WHERE length(text) BETWEEN 2 AND 30 GROUP BY text HAVING days >= 5 AND n >= 5 ORDER BY n DESC LIMIT 30").all();
    for (const r of rows) {
      const exists = d.prepare('SELECT id FROM skills WHERE trigger = ? LIMIT 1').get(r.text);
      if (exists) { d.prepare('UPDATE skills SET strength = MIN(1, strength + 0.1), reinforced_at = ? WHERE id = ?').run(now(), exists.id); continue; }
      d.prepare('INSERT INTO skills (name, trigger, response, strength, reinforced_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('reflex:' + String(r.text).slice(0, 20), r.text, '看到这个模式时按习惯自然反应，不重新推理', Math.min(1, 0.6 + Number(r.days) / 20), now(), 'active', now());
      n++;
    }
  } catch {}
  // 语义聚类兜底：文本不完全相同，但向量相近也算同一反射模式。
  try {
    const rows = d.prepare("SELECT text, occurred_at FROM events WHERE length(text) BETWEEN 2 AND 40 ORDER BY occurred_at DESC LIMIT 500").all();
    const clusters = [];
    for (const r of rows) {
      const v = hashVector(r.text);
      const day = new Date(Number(r.occurred_at)).toISOString().slice(0, 10);
      let hit = null;
      for (const c of clusters) { if (cosine(v, c.v) >= 0.86) { hit = c; break; } }
      if (!hit) { hit = { v, texts: [], days: new Set() }; clusters.push(hit); }
      hit.texts.push(String(r.text)); hit.days.add(day);
    }
    for (const c of clusters) {
      if (c.days.size < 5) continue;
      const trigger = c.texts[0];
      if (d.prepare('SELECT id FROM skills WHERE trigger = ? LIMIT 1').get(trigger)) continue;
      d.prepare('INSERT INTO skills (name, trigger, response, strength, reinforced_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('reflex:' + String(trigger).slice(0, 20), trigger, '看到这个模式时按习惯自然反应，不重新推理', Math.min(1, 0.65 + c.days.size / 20), now(), 'active', now());
      n++;
    }
  } catch {}
  return n;
}

export function backfillVectors() {
  const d = openMemory();
  let n = 0;
  try {
    const rows = d.prepare('SELECT id, text FROM events WHERE id NOT IN (SELECT event_id FROM event_vectors) LIMIT 2000').all();
    for (const r of rows) { d.prepare('INSERT OR REPLACE INTO event_vectors (event_id, vector_json) VALUES (?, ?)').run(r.id, JSON.stringify(hashVector(r.text))); n++; }
  } catch {}
  return n;
}

export function stats() {
  const d = openMemory();
  const one = (sql) => { try { return d.prepare(sql).get(); } catch { return {}; } };
  return { events: one('SELECT COUNT(*) AS n FROM events').n || 0, people: one('SELECT COUNT(*) AS n FROM people').n || 0, platform: one('SELECT COUNT(*) AS n FROM platform_items').n || 0, skills: one('SELECT COUNT(*) AS n FROM skills').n || 0 };
}
