// 视频知识卡 + 技能等级：SQLite 持久化，按主题检索。
// 只追加/更新，不删除；技能只升不降。
import { openMemory } from './memory-store.mjs';

let ready = false;
function db() {
  const d = openMemory();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bvid TEXT,
        topic TEXT,
        title TEXT,
        facts_json TEXT,
        steps_json TEXT,
        prerequisites_json TEXT,
        pitfalls_json TEXT,
        confidence REAL DEFAULT 0.5,
        source TEXT,
        scope TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        UNIQUE(bvid, topic)
      );
      CREATE TABLE IF NOT EXISTS skill_levels (
        name TEXT PRIMARY KEY,
        level TEXT DEFAULT 'seen',
        evidence TEXT,
        source_bvid TEXT,
        updated_at INTEGER,
        created_at INTEGER
      );
    `);
    try { d.exec('ALTER TABLE knowledge_cards ADD COLUMN scope TEXT'); } catch {}
    ready = true;
  }
  return d;
}
const LEVELS = { seen: 0, understood: 1, practiced: 2, verified: 3 };
function arr(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }

export function saveKnowledgeCard({ bvid = '', topic = '', title = '', facts = [], steps = [], prerequisites = [], pitfalls = [], confidence = 0.5, source = '', scope = null } = {}) {
  const d = db(); const now = Date.now();
  const t = String(topic || title || '').slice(0, 80);
  if (!t) return null;
  d.prepare(`INSERT INTO knowledge_cards (bvid,topic,title,facts_json,steps_json,prerequisites_json,pitfalls_json,confidence,source,scope,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bvid,topic) DO UPDATE SET title=excluded.title, facts_json=excluded.facts_json, steps_json=excluded.steps_json,
      prerequisites_json=excluded.prerequisites_json, pitfalls_json=excluded.pitfalls_json, confidence=excluded.confidence,
      source=excluded.source, scope=COALESCE(excluded.scope, knowledge_cards.scope), updated_at=excluded.updated_at
      -- A05-rework1：新卡必须有明确 scope；旧卡 scope NULL 保守不展示。
    `).run(
    String(bvid).slice(0, 40), t.slice(0, 80), String(title || '').slice(0, 160),
    JSON.stringify((facts || []).slice(0, 12)), JSON.stringify((steps || []).slice(0, 12)),
    JSON.stringify((prerequisites || []).slice(0, 8)), JSON.stringify((pitfalls || []).slice(0, 8)),
    Math.max(0, Math.min(1, Number(confidence) || 0.5)), String(source || '').slice(0, 200), scope, now, now
  );
  return d.prepare('SELECT * FROM knowledge_cards WHERE bvid=? AND topic=?').get(String(bvid).slice(0, 40), t.slice(0, 80));
}

export function upsertSkill({ name = '', level = 'seen', evidence = '', sourceBvid = '' } = {}) {
  const d = db(); const n = String(name || '').slice(0, 80);
  if (!n) return null;
  const lv = LEVELS[String(level)] == null ? 'seen' : String(level);
  const old = d.prepare('SELECT * FROM skill_levels WHERE name=?').get(n);
  const now = Date.now();
  if (!old) {
    d.prepare('INSERT INTO skill_levels (name,level,evidence,source_bvid,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(n, lv, String(evidence || '').slice(0, 500), String(sourceBvid || '').slice(0, 40), now, now);
  } else if ((LEVELS[lv] || 0) > (LEVELS[old.level] || 0)) {
    d.prepare('UPDATE skill_levels SET level=?,evidence=?,source_bvid=?,updated_at=? WHERE name=?').run(lv, String(evidence || old.evidence || '').slice(0, 500), String(sourceBvid || old.source_bvid || '').slice(0, 40), now, n);
  }
  return d.prepare('SELECT * FROM skill_levels WHERE name=?').get(n);
}

export function listSkills(limit = 20) {
  try { return db().prepare('SELECT * FROM skill_levels ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, limit)); } catch { return []; }
}

export function listKnowledge(limit = 50) {
  try { return db().prepare('SELECT * FROM knowledge_cards ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, limit)); } catch { return []; }
}

export function searchKnowledge(query, limit = 3, { scopes = [] } = {}) {
  try {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const allowed = (Array.isArray(scopes) ? scopes : []).map(String).filter(Boolean);
    if (!allowed.length) return [];
    const tokens = q.match(/[\p{Script=Han}]{2,6}|[a-z0-9_]{3,}/gu) || [];
    const rows = db().prepare(`SELECT * FROM knowledge_cards
      WHERE scope IS NOT NULL AND (scope IN (${allowed.map(() => '?').join(',')}) OR scope = 'shared')
      ORDER BY updated_at DESC LIMIT 300`).all(...allowed);
    const scored = rows.map((r) => {
      const blob = [r.topic, r.title, r.facts_json, r.steps_json, r.pitfalls_json].join(' ').toLowerCase();
      let score = 0; for (const t of tokens) if (blob.includes(t)) score += 1;
      return { ...r, score };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
    return scored;
  } catch { return []; }
}

export function knowledgeBrief(query = '', limit = 2, { scopes = [] } = {}) {
  const cards = searchKnowledge(query, limit, { scopes });
  if (!cards.length) return '';
  const skills = listSkills(8);
  const lines = cards.map((c) => {
    const facts = arr(c.facts_json).slice(0, 3).join('；');
    const steps = arr(c.steps_json).slice(0, 4);
    return `- 【知识卡】${String(c.topic || c.title).slice(0, 60)}：${facts || String(c.title || '').slice(0, 80)}${steps.length ? '；步骤：' + steps.map((x) => String(x).slice(0, 50)).join(' → ') : ''}（来源 ${c.bvid || c.source || 'B站'}）`;
  });
  const skillLine = skills.length ? '【技能等级】' + skills.map((s) => `${s.name}:${s.level}`).join('、') : '';
  return `【知识与技能】\n${lines.join('\n')}${skillLine ? '\n' + skillLine : ''}\n\n`;
}
