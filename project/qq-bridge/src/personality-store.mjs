// A02 人格状态底座：SQLite 事务存储、快照、事件幂等、决策结果、迁移 dry-run 与降级。
//
// F01–F04 返工后的边界：
//   · 持久化读取严格解析；坏 JSON/缺字段/坏 revision 不补默认值，直接降级。
//   · 降级是粘性的：读取失败后，所有写入口先拒绝，不能因连接仍存在而绕过。
//   · loadSnapshot 的 persona/state/events/decisions 在同一个 SQLite 读事务中。
//   · 备份目标用 COPYFILE_EXCL 创建，同名碰撞自动换名，绝不覆盖已有恢复点。
//   · 初始化写入单独放在 BEGIN IMMEDIATE 中；导入模块不打开数据库。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalFactKey, legacyPlainFactKey, legacyHashedFactKeys, coreFactFromEvent } from './personality-facts.mjs';
import {
  PERSONALITY_SCHEMA_VERSION, DEFAULT_PERSONA, DEFAULT_SCOPE,
  normalizePersona, initialState, normalizeState, applyStateDelta,
  initialRelationship, normalizeRelationship, applyRelationshipDelta,
  normalizeEvent, normalizeDecision, isScope, snapshotHash, planLegacyMigration,
} from './personality-schema.mjs';

const DB_SCHEMA_VERSION = 1;
const BUSY_RETRIES = 20;
const BUSY_WAIT_MS = 25;
const BACKUP_ATTEMPTS = 1000;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function dbPathFor(dataRoot) {
  return path.join(path.resolve(dataRoot), 'state', 'personality.sqlite');
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function safeJson(value) {
  return JSON.stringify(value ?? null);
}

function parseStrict(text, label) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${label} 缺失或为空`);
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`${label} 不是合法 JSON：${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 不是对象`);
  return value;
}

// 持久化状态必须字段齐全；不能用 normalizeState 的默认值掩盖缺字段。
function parseStoredState(text) {
  const value = parseStrict(text, 'snapshots.state_json');
  for (const key of ['valence', 'energy', 'stress', 'attention']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new Error(`snapshots.state_json.${key} 缺失或非数值`);
  }
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) throw new Error('snapshots.state_json.updatedAt 缺失');
  if (!Array.isArray(value.causeEventIds)) throw new Error('snapshots.state_json.causeEventIds 缺失');
  return normalizeState(value, { now: value.updatedAt });
}

export function backupLegacyFile(source, backupRoot) {
  const src = path.resolve(source);
  const before = sha256File(src);
  if (!before) return { ok: false, error: 'source-unreadable', source: src };
  fs.mkdirSync(backupRoot, { recursive: true });
  const base = `${path.basename(source)}.${Date.now()}`;
  let lastError = null;
  for (let i = 0; i < BACKUP_ATTEMPTS; i += 1) {
    const target = path.join(backupRoot, `${base}${i === 0 ? '' : `-${i}`}.bak`);
    try {
      // COPYFILE_EXCL：目标已存在就失败，绝不覆盖任何旧恢复点。
      fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
      const backupHash = sha256File(target);
      const after = sha256File(src);
      if (backupHash !== before || after !== before) {
        return { ok: false, error: 'hash-mismatch', source: src, backup: target, before, backupHash, after };
      }
      return { ok: true, source: src, backup: target, sha256: before, attempts: i + 1 };
    } catch (error) {
      lastError = error;
      if (error?.code === 'EEXIST') continue;
      return { ok: false, error: String(error?.message ?? error), source: src, backup: target };
    }
  }
  return { ok: false, error: `backup-exhausted: ${lastError?.message ?? 'target exists'}`, source: src };
}

export function createPersonalityStore({ dataRoot, clock = Date.now } = {}) {
  if (!dataRoot) throw new Error('dataRoot 必填：A02 不允许默认写 LIVE 状态目录');
  const dbFile = dbPathFor(dataRoot);
  let db = null;
  let status = 'new';
  let degraded = null;
  let initialized = false;

  const nowIso = () => new Date(Number(clock())).toISOString();

  function setDegraded(reason, error, extra = {}) {
    status = 'degraded';
    degraded = { reason, error: String(error ?? ''), at: nowIso(), ...extra };
  }

  function blocked() {
    return degraded ? {
      ok: false, degraded: true, status: 'degraded',
      error: degraded.error || degraded.reason, reason: degraded.reason,
    } : null;
  }

  function open(attempt = 0) {
    if (degraded) return false;
    if (db) return true;
    try {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      db = new DatabaseSync(dbFile);
      // 并发首次初始化时，任何 PRAGMA/DDL 之前先设置 busy 等待。
      db.exec('PRAGMA busy_timeout=5000;');
      // 先读已有 schema 版本；版本过高时不得建表/改 PRAGMA，保留现场。
      const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personality_meta'").get();
      if (hasMeta) {
        const version = db.prepare('SELECT value FROM personality_meta WHERE key = ?').get('schema_version');
        const v = Number(version?.value);
        if (!Number.isSafeInteger(v) || v > DB_SCHEMA_VERSION) {
          setDegraded('schema-unsupported', `db schema ${version?.value} > ${DB_SCHEMA_VERSION}`);
          try { db.close(); } catch {}
          db = null;
          return false;
        }
      }
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=NORMAL;');
      db.exec('PRAGMA busy_timeout=5000;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS personality_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS persona (
          persona_version TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          doc_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          scope TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          occurred_at TEXT,
          scheduled_at TEXT,
          recorded_at TEXT NOT NULL,
          reality TEXT NOT NULL,
          status TEXT NOT NULL,
          confidence REAL NOT NULL,
          evidence_refs_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state_delta_json TEXT,
          relationship_delta_json TEXT,
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS decisions (
          decision_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          revision INTEGER NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relationships (
          actor_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          relationship_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relationship_facts (
          fact_key TEXT PRIMARY KEY,
          actor_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL,
          event_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_scope_time ON events(scope, recorded_at);
        CREATE INDEX IF NOT EXISTS idx_decisions_scope ON decisions(scope, created_at);
        CREATE INDEX IF NOT EXISTS idx_relationships_updated ON relationships(updated_at);
        CREATE INDEX IF NOT EXISTS idx_relationship_facts_actor ON relationship_facts(actor_id, applied_at);
      `);
      // A04 迁移：v1 库没有 relationship 列/表。只做加法，不重建、不覆盖既有事件。
      const eventColumns = db.prepare('PRAGMA table_info(events)').all();
      if (!eventColumns.some((col) => col.name === 'relationship_delta_json')) {
        db.exec('ALTER TABLE events ADD COLUMN relationship_delta_json TEXT');
      }
      const row = db.prepare('SELECT value FROM personality_meta WHERE key = ?').get('schema_version');
      if (!row) db.prepare('INSERT INTO personality_meta(key,value) VALUES(?,?)').run('schema_version', String(DB_SCHEMA_VERSION));
      // A04 只做加法（relationships 表 + events.relationship_delta_json），保持 schema_version=1，
      // 这样回滚到 A03 代码时不会因“版本过高”被降级；旧代码会忽略新增表/列。
      status = 'ok';
      return true;
    } catch (error) {
      if (/busy|locked|readonly/i.test(String(error?.message ?? error)) && attempt < 120) {
        if (db) { try { db.close(); } catch {} db = null; }
        sleepSync(50);
        return open(attempt + 1);
      }
      setDegraded('unavailable', error?.message ?? error, { dbFile });
      if (db) { try { db.close(); } catch {} db = null; }
      return false;
    }
  }

  function withImmediate(fn) {
    let lastError = null;
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        lastError = error;
        if (/busy|locked/i.test(String(error?.message ?? error))) { sleepSync(BUSY_WAIT_MS); continue; }
        throw error;
      }
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    throw lastError ?? new Error('database busy');
  }

  function withReadSnapshot(fn) {
    let lastError = null;
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      try {
        db.exec('BEGIN');
      } catch (error) {
        lastError = error;
        if (/busy|locked/i.test(String(error?.message ?? error))) { sleepSync(BUSY_WAIT_MS); continue; }
        throw error;
      }
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    throw lastError ?? new Error('database busy');
  }

  function countEvents(scope) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM events WHERE scope = ?').get(scope);
    return Number(row?.n) || 0;
  }

  function readMeta(key) {
    const row = db.prepare('SELECT value FROM personality_meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  function setMeta(key, value) {
    db.prepare('INSERT OR REPLACE INTO personality_meta(key,value) VALUES(?,?)').run(key, String(value));
  }

  function hasAnyRows() {
    for (const table of ['persona', 'snapshots', 'events', 'decisions', 'relationships', 'relationship_facts']) {
      if (db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table}) AS e`).get().e) return true;
    }
    return false;
  }

  // 内容健康检查：稳定人格、所有已存在 scope 的状态、事件/决策引用、revision。
  function validateHealthCore() {
    const faults = [];
    try {
      const activeCount = Number(db.prepare('SELECT COUNT(*) AS n FROM persona WHERE active = 1').get().n);
      if (activeCount !== 1) faults.push({ reason: 'persona-active-count', detail: activeCount });
      const persona = getActivePersona();
      if (!persona?.personaVersion) faults.push({ reason: 'persona-invalid' });
    } catch (error) {
      faults.push({ reason: 'persona-invalid', error: String(error?.message ?? error) });
    }
    const scopes = new Set();
    try {
      const rows = db.prepare('SELECT scope, revision, state_json FROM snapshots').all();
      for (const row of rows) {
        if (!isScope(row.scope)) { faults.push({ reason: 'snapshot-scope-invalid', scope: row.scope }); continue; }
        scopes.add(row.scope);
        const revision = Number(row.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) faults.push({ reason: 'snapshot-revision-invalid', scope: row.scope, revision: row.revision });
        try { parseStoredState(row.state_json); }
        catch (error) { faults.push({ reason: 'snapshot-state-invalid', scope: row.scope, error: String(error?.message ?? error) }); }
      }
      if (!scopes.has(DEFAULT_SCOPE)) faults.push({ reason: 'global-snapshot-missing' });
      for (const row of db.prepare('SELECT DISTINCT scope FROM events').all()) {
        if (!scopes.has(row.scope)) faults.push({ reason: 'event-scope-without-snapshot', scope: row.scope });
      }
      for (const row of db.prepare('SELECT DISTINCT scope FROM decisions').all()) {
        if (!scopes.has(row.scope)) faults.push({ reason: 'decision-scope-without-snapshot', scope: row.scope });
      }
      for (const row of db.prepare('SELECT actor_id, revision, relationship_json FROM relationships').all()) {
        const actorId = String(row.actor_id ?? '');
        if (!actorId || /[\u0000-\u001F\u007F]/.test(actorId)) faults.push({ reason: 'relationship-actor-invalid', actorId });
        const revision = Number(row.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) faults.push({ reason: 'relationship-revision-invalid', actorId, revision: row.revision });
        try { normalizeRelationship(parseStrict(row.relationship_json, 'relationships.relationship_json'), { now: nowIso() }); }
        catch (error) { faults.push({ reason: 'relationship-json-invalid', actorId, error: String(error?.message ?? error) }); }
      }
      for (const row of db.prepare('SELECT decision_id, result_json FROM decisions').all()) {
        try { normalizeDecision(parseStrict(row.result_json, 'decisions.result_json')); }
        catch (error) { faults.push({ reason: 'decision-json-invalid', decisionId: row.decision_id, error: String(error?.message ?? error) }); }
      }
    } catch (error) {
      faults.push({ reason: 'health-read-failed', error: String(error?.message ?? error) });
    }
    return { ok: faults.length === 0, faults };
  }

  // 事务外调用时，整个健康判断来自同一个 SQLite 读快照。
  // 写事务内部调用 validateHealthCore()，由写事务自己拥有事务，避免嵌套 BEGIN。
  function validateHealth() {
    return withReadSnapshot(() => validateHealthCore());
  }

  function ensureInitialized() {
    if (degraded) return false;
    if (!open()) return false;
    if (initialized) return true;
    try {
      const marker = readMeta('initialized');
      if (marker === '1') {
        const health = validateHealth();
        if (!health.ok) {
          setDegraded('content-invalid', health.faults.map((f) => f.reason).join(','), { faults: health.faults });
          return false;
        }
        initialized = true;
        return true;
      }
      const anyRows = hasAnyRows();
      if (!anyRows) {
        // 明确首次创建：persona、global snapshot、初始化标志在同一个事务。
        withImmediate(() => {
          const active = db.prepare('SELECT persona_version FROM persona WHERE active = 1 LIMIT 1').get();
          if (!active) {
            const persona = normalizePersona(DEFAULT_PERSONA);
            db.prepare('INSERT OR IGNORE INTO persona(persona_version,schema_version,doc_json,active,created_at) VALUES(?,?,?,?,?)')
              .run(persona.personaVersion, PERSONALITY_SCHEMA_VERSION, safeJson(persona), 1, nowIso());
          }
          const state = db.prepare('SELECT scope FROM snapshots WHERE scope = ?').get(DEFAULT_SCOPE);
          if (!state) {
            const st = initialState(nowIso());
            db.prepare('INSERT OR IGNORE INTO snapshots(scope,revision,state_json,updated_at) VALUES(?,?,?,?)')
              .run(DEFAULT_SCOPE, 0, safeJson(st), st.updatedAt);
          }
          setMeta('initialized', '1');
        });
      } else {
        // 兼容 A02/rework1 的 schema=1 旧库：有任意持久行但无标志。
        // 先严格验证；健康才补标志，坏库绝不重新种默认值。
        withImmediate(() => {
          const health = validateHealthCore();
          if (!health.ok) {
            const error = new Error('content-invalid-during-init');
            error.faults = health.faults;
            throw error;
          }
          setMeta('initialized', '1');
        });
      }
      const health = validateHealth();
      if (!health.ok) {
        setDegraded('content-invalid', health.faults.map((f) => f.reason).join(','), { faults: health.faults });
        return false;
      }
      initialized = true;
      return true;
    } catch (error) {
      if (error?.faults) setDegraded('content-invalid', error.faults.map((f) => f.reason).join(','), { faults: error.faults });
      else setDegraded('init-failed', error?.message ?? error, { dbFile });
      return false;
    }
  }

  function countDecisions(scope) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE scope = ?').get(scope);
    return Number(row?.n) || 0;
  }

  // 事务内核心：调用方必须已持有 BEGIN IMMEDIATE。不得自行 BEGIN。
  function ensureScopeCore(scope) {
    const row = db.prepare('SELECT scope FROM snapshots WHERE scope = ?').get(scope);
    if (row) return false;
    if (countEvents(scope) > 0 || countDecisions(scope) > 0) {
      throw new Error(`snapshot-missing-with-history:${scope}`);
    }
    const st = initialState(nowIso());
    db.prepare('INSERT OR IGNORE INTO snapshots(scope,revision,state_json,updated_at) VALUES(?,?,?,?)')
      .run(scope, 0, safeJson(st), st.updatedAt);
    return true;
  }

  function getStateRow(scope) {
    const row = db.prepare('SELECT revision, state_json FROM snapshots WHERE scope = ?').get(scope);
    if (!row) throw new Error(`snapshot-missing:${scope}`);
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`snapshots.revision 非法：${row.revision}`);
    return { revision, state: parseStoredState(row.state_json) };
  }

  function relationshipFactKeys(event) {
    const core = coreFactFromEvent(event);
    const candidates = [];
    let primary = null;
    if (core) {
      primary = canonicalFactKey(core);
      if (primary) candidates.push(primary);
      const plain = legacyPlainFactKey(core);
      if (plain) candidates.push(plain);
      candidates.push(...legacyHashedFactKeys({ ...core, evidenceRefs: [core.messageId] }));
    }
    const refs = [...new Set((Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []).map(String).filter(Boolean))].sort();
    candidates.push(...legacyHashedFactKeys({ scope: event.scope, actorId: event.actorId, evidenceRefs: refs }));
    if (!primary) primary = candidates.find(Boolean) || null;
    return { primary, candidates: [...new Set(candidates.filter(Boolean))], core };
  }

  function getRelationshipRow(actorId) {
    const row = db.prepare('SELECT revision, relationship_json FROM relationships WHERE actor_id = ?').get(String(actorId));
    if (!row) return { revision: 0, relationship: initialRelationship(nowIso()) };
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`relationships.revision 非法：${row.revision}`);
    return { revision, relationship: normalizeRelationship(parseStrict(row.relationship_json, 'relationships.relationship_json'), { now: nowIso() }) };
  }

  function listRelationships(limit = 200) {
    const max = Math.min(500, Math.max(1, Number(limit) || 200));
    const rows = db.prepare('SELECT actor_id, relationship_json FROM relationships ORDER BY updated_at DESC LIMIT ?').all(max);
    const out = {};
    for (const row of rows) {
      try { out[String(row.actor_id)] = normalizeRelationship(parseStrict(row.relationship_json, 'relationships.relationship_json'), { now: nowIso() }); }
      catch { throw new Error(`relationship-invalid:${row.actor_id}`); }
    }
    return out;
  }

  function getActivePersona() {
    const row = db.prepare('SELECT doc_json FROM persona WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
    if (!row) throw new Error('persona-missing');
    const value = parseStrict(row.doc_json, 'persona.doc_json');
    return normalizePersona(value);
  }

  function readScopeData(scope) {
    const persona = getActivePersona();
    const { revision, state } = getStateRow(scope);
    const events = db.prepare('SELECT event_id FROM events WHERE scope = ? ORDER BY rowid DESC LIMIT 20').all(scope).map((r) => r.event_id);
    const decisions = db.prepare('SELECT decision_id FROM decisions WHERE scope = ? ORDER BY rowid DESC LIMIT 20').all(scope).map((r) => r.decision_id);
    return { persona, revision, state, events, decisions, relationships: listRelationships() };
  }

  function loadRelationship(actorId, { scope = null } = {}) {
    if (!actorId) return { ok: false, error: 'actorId 必填' };
    if (degraded) return blocked();
    if (!ensureInitialized()) return { ok: false, degraded: true, status, error: degraded?.error ?? 'unavailable' };
    try {
      const data = withReadSnapshot(() => {
        const { revision, relationship } = getRelationshipRow(actorId);
        let evidenceIds = [];
        if (scope != null) {
          if (!isScope(scope)) throw new Error('scope 非法');
          const cause = new Set(relationship.causeEventIds.map(String));
          const rows = db.prepare('SELECT event_id FROM events WHERE actor_id = ? AND scope = ? ORDER BY rowid DESC LIMIT 40').all(String(actorId), scope);
          evidenceIds = rows.map((r) => String(r.event_id)).filter((id) => cause.has(id)).slice(-10);
        }
        return { revision, relationship, evidenceIds };
      });
      return { ok: true, actorId: String(actorId), ...data };
    } catch (error) {
      setDegraded('read-failed', error?.message ?? error);
      return { ok: false, degraded: true, status, error: degraded?.error };
    }
  }

  function loadSnapshot(scope = DEFAULT_SCOPE) {
    if (!isScope(scope)) return { ok: false, error: 'scope 非法', degraded: Boolean(degraded) };
    if (degraded) return blocked();
    if (!ensureInitialized()) return { ok: false, degraded: true, status, error: degraded?.error ?? 'unavailable' };
    try {
      const exists = db.prepare('SELECT scope FROM snapshots WHERE scope = ?').get(scope);
      let data;
      if (exists) {
        data = withReadSnapshot(() => readScopeData(scope));
      } else {
        // 读路径创建新 scope：健康校验 + scope 创建 + 读取在同一写事务。
        // 任何校验/读取失败都回滚，不能留下默认状态。
        const created = withImmediate(() => {
          const health = validateHealthCore();
          if (!health.ok) {
            setDegraded('content-invalid', health.faults.map((f) => f.reason).join(','), { faults: health.faults });
            return { ok: false, degraded: true, status, error: degraded?.error ?? 'content-invalid' };
          }
          try {
            ensureScopeCore(scope);
          } catch (error) {
            setDegraded('snapshot-missing', error?.message ?? error, { scope });
            return { ok: false, degraded: true, status, error: degraded?.error };
          }
          return { ok: true, data: readScopeData(scope) };
        });
        if (!created.ok) return created;
        data = created.data;
      }
      const snapshot = {
        schemaVersion: PERSONALITY_SCHEMA_VERSION,
        personaVersion: data.persona.personaVersion,
        persona: data.persona,
        scope,
        revision: data.revision,
        state: data.state,
        relationships: data.relationships,
        recentEventIds: data.events,
        recentDecisionIds: data.decisions,
      };
      return { ok: true, degraded: false, snapshot, revision: data.revision, hash: snapshotHash(snapshot) };
    } catch (error) {
      setDegraded('read-failed', error?.message ?? error);
      return { ok: false, degraded: true, status, error: degraded?.error };
    }
  }

  function submitEvent(candidate, expectedRevision) {
    if (degraded) return blocked();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return { ok: false, error: 'expectedRevision 必须是非负整数' };
    }
    let event;
    try { event = normalizeEvent(candidate); }
    catch (error) { return { ok: false, error: `invalid-event: ${error?.message ?? error}` }; }
    if (!ensureInitialized()) return { ok: false, degraded: true, status, error: degraded?.error ?? 'unavailable' };
    try {
      return withImmediate(() => {
        const health = validateHealthCore();
        if (!health.ok) {
          setDegraded('content-invalid', health.faults.map((f) => f.reason).join(','), { faults: health.faults });
          return blocked();
        }
        // event_id 是全局主键，但重复结果必须归属到“已有事件实际所属的 scope”，
        // 不能拿本次输入 scope 去拼重复结果。跨 scope 复用 ID 是输入冲突，不是库损坏。
        const duplicate = db.prepare('SELECT event_id, scope, revision FROM events WHERE event_id = ?').get(event.eventId);
        if (duplicate) {
          const existingScope = String(duplicate.scope);
          if (existingScope !== event.scope) {
            const { revision: existingRevision } = getStateRow(existingScope);
            return {
              ok: false, conflict: true, code: 'event-id-conflict', error: 'event-id-conflict',
              eventId: event.eventId, scope: event.scope, existingScope,
              revision: existingRevision, revisionScope: existingScope,
              existingEventRevision: Number(duplicate.revision),
            };
          }
          const { revision } = getStateRow(existingScope);
          return { ok: true, applied: false, duplicate: true, revision, revisionScope: existingScope, eventId: event.eventId };
        }
        const factKeys = event.relationshipDelta ? relationshipFactKeys(event) : { primary: null, candidates: [], core: null };
        if (factKeys.candidates.length) {
          for (const candidate of factKeys.candidates) {
            const seenFact = db.prepare('SELECT event_id FROM relationship_facts WHERE fact_key = ?').get(candidate);
            if (seenFact) {
              const { revision } = getStateRow(event.scope);
              return { ok: true, applied: false, duplicateFact: true, factKey: candidate, eventId: event.eventId, existingEventId: String(seenFact.event_id), revision };
            }
          }
        }
        const factKey = factKeys.primary;
        let stateRow;
        try {
          stateRow = getStateRow(event.scope);
        } catch (error) {
          if (expectedRevision !== 0) {
            // 新 scope 只有 expectedRevision=0 才允许创建；冲突不得留下默认快照。
            return { ok: false, conflict: true, revision: 0, expectedRevision, eventId: event.eventId };
          }
          try {
            ensureScopeCore(event.scope);
          } catch (scopeError) {
            setDegraded('snapshot-missing', scopeError?.message ?? scopeError, { scope: event.scope });
            return { ok: false, degraded: true, status, error: degraded?.error };
          }
          stateRow = getStateRow(event.scope);
        }
        const { revision, state } = stateRow;
        if (revision !== expectedRevision) {
          return { ok: false, conflict: true, revision, expectedRevision, eventId: event.eventId };
        }
        const nextState = applyStateDelta(state, event.stateDelta, { now: nowIso(), eventId: event.eventId });
        const nextRevision = revision + 1;
        let relationshipRevision = null;
        let nextRelationship = null;
        if (event.relationshipDelta) {
          const relRow = getRelationshipRow(event.actorId);
          nextRelationship = applyRelationshipDelta(relRow.relationship, event.relationshipDelta, { now: nowIso(), eventId: event.eventId });
          relationshipRevision = relRow.revision + 1;
          db.prepare('INSERT OR REPLACE INTO relationships(actor_id,revision,relationship_json,updated_at) VALUES(?,?,?,?)')
            .run(String(event.actorId), relationshipRevision, safeJson(nextRelationship), nextRelationship.updatedAt);
          if (factKey) {
            db.prepare('INSERT INTO relationship_facts(fact_key,actor_id,scope,kind,event_id,applied_at) VALUES(?,?,?,?,?,?)')
              .run(factKey, String(event.actorId), String(event.scope), String(event.kind), String(event.eventId), nowIso());
          }
        }
        db.prepare('INSERT INTO events(event_id,scope,kind,source,actor_id,occurred_at,scheduled_at,recorded_at,reality,status,confidence,evidence_refs_json,payload_json,state_delta_json,relationship_delta_json,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(event.eventId, event.scope, event.kind, event.source, event.actorId, event.occurredAt, event.scheduledAt,
            event.recordedAt, event.reality, event.status, event.confidence, safeJson(event.evidenceRefs), safeJson(event.payload),
            event.stateDelta ? safeJson(event.stateDelta) : null, event.relationshipDelta ? safeJson(event.relationshipDelta) : null, nextRevision);
        db.prepare('UPDATE snapshots SET revision = ?, state_json = ?, updated_at = ? WHERE scope = ?')
          .run(nextRevision, safeJson(nextState), nextState.updatedAt, event.scope);
        return { ok: true, applied: true, duplicate: false, revision: nextRevision, eventId: event.eventId, relationshipRevision, relationship: nextRelationship, snapshotHash: snapshotHash({ scope: event.scope, revision: nextRevision, state: nextState }) };
      });
    } catch (error) {
      setDegraded('write-failed', error?.message ?? error);
      return { ok: false, degraded: true, error: degraded?.error };
    }
  }

  function commitDecisionOutcome(candidate, expectedRevision = null) {
    if (degraded) return blocked();
    let result;
    try { result = normalizeDecision(candidate); }
    catch (error) { return { ok: false, error: `invalid-decision: ${error?.message ?? error}` }; }
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return { ok: false, error: 'expectedRevision 必须是非负整数或 null' };
    }
    if (!ensureInitialized()) return { ok: false, degraded: true, status, error: degraded?.error ?? 'unavailable' };
    try {
      return withImmediate(() => {
        const health = validateHealthCore();
        if (!health.ok) {
          setDegraded('content-invalid', health.faults.map((f) => f.reason).join(','), { faults: health.faults });
          return blocked();
        }
        const duplicate = db.prepare('SELECT decision_id FROM decisions WHERE decision_id = ?').get(result.decisionId);
        const { revision } = getStateRow(DEFAULT_SCOPE);
        if (duplicate) return { ok: true, applied: false, duplicate: true, revision, decisionId: result.decisionId };
        if (expectedRevision !== null && expectedRevision !== revision) {
          return { ok: false, conflict: true, revision, expectedRevision, decisionId: result.decisionId };
        }
        db.prepare('INSERT INTO decisions(decision_id,scope,revision,result_json,created_at) VALUES(?,?,?,?,?)')
          .run(result.decisionId, DEFAULT_SCOPE, revision, safeJson(result), nowIso());
        return { ok: true, applied: true, duplicate: false, revision, decisionId: result.decisionId };
      });
    } catch (error) {
      setDegraded('write-failed', error?.message ?? error);
      return { ok: false, degraded: true, error: degraded?.error };
    }
  }

  function dryRunMigration(legacy) {
    return planLegacyMigration(legacy);
  }

  function recover() {
    // 显式恢复：在验证内容健康之前不发布健康状态。
    if (db) { try { db.close(); } catch {} }
    db = null;
    degraded = null;
    status = 'new';
    initialized = false;
    if (!open()) return { ok: false, degraded: true, status, error: degraded?.error ?? 'unavailable' };
    if (!ensureInitialized()) return { ok: false, degraded: true, status, error: degraded?.error ?? 'unavailable' };
    const health = validateHealth();
    if (!health.ok) {
      setDegraded('content-invalid', health.faults.map((f) => f.reason).join(','), { faults: health.faults });
      return { ok: false, degraded: true, status, error: degraded.error, faults: health.faults };
    }
    status = 'ok';
    return { ok: true, status: 'ok', degraded: null, faults: [] };
  }

  function getStatus() {
    return { ok: status === 'ok' && !degraded, status, degraded, dbFile, schemaVersion: DB_SCHEMA_VERSION, initialized };
  }

  function close() {
    if (db) { try { db.close(); } catch {} }
    db = null;
    initialized = false;
    status = 'closed';
  }

  return {
    dbFile,
    loadSnapshot,
    loadRelationship,
    submitEvent,
    commitDecisionOutcome,
    dryRunMigration,
    getStatus,
    recover,
    close,
  };
}
