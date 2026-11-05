const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
// A02 人格状态底座专项测试：全部写入临时目录，不连 LIVE/bridge/网络。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const candidate = CANDIDATE_ROOT;
const imp = (rel) => import(pathToFileURL(path.join(candidate, rel)).href);
const schema = await imp('qq-bridge/src/personality-schema.mjs');
const { createPersonalityStore, backupLegacyFile } = await imp('qq-bridge/src/personality-store.mjs');
const { DatabaseSync } = await import('node:sqlite');

const report = { package: 'A02', startedAt: new Date().toISOString(), tests: [], summary: {} };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a02-personality-'));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixedClock = () => Date.parse('2026-10-29T16:00:00.000Z');

function test(id, name, fn) {
  const start = Date.now();
  try {
    const detail = fn();
    report.tests.push({ id, name, ok: true, detail, ms: Date.now() - start });
  } catch (error) {
    report.tests.push({ id, name, ok: false, error: String(error?.stack ?? error), ms: Date.now() - start });
  }
}

function event(overrides = {}) {
  return schema.normalizeEvent({
    eventId: 'e-synthetic-1',
    source: 'synthetic',
    scope: 'global',
    actorId: 'person-1',
    kind: 'interaction.positive',
    occurredAt: '2026-10-29T15:59:00.000Z',
    recordedAt: '2026-10-29T16:00:00.000Z',
    reality: 'observed',
    status: 'completed',
    confidence: 0.9,
    evidenceRefs: ['ev-1'],
    payload: { note: 'synthetic' },
    stateDelta: { valence: 0.1, energy: -0.05 },
    ...overrides,
  });
}

// T01 首次快照
test('T01', '首次 loadSnapshot 初始化稳定人格/中性状态，revision=0', () => {
  const dir = path.join(root, 't01');
  const store = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const r = store.loadSnapshot();
  assert.equal(r.ok, true);
  assert.equal(r.revision, 0);
  assert.equal(r.snapshot.personaVersion, 'p-0001');
  assert.equal(r.snapshot.persona.identity.kind, 'virtual');
  assert.equal(r.snapshot.state.valence, 0);
  assert.equal(r.snapshot.state.updatedAt, '2026-10-29T16:00:00.000Z');
  store.close();
  return { revision: r.revision, personaVersion: r.snapshot.personaVersion };
});

// T02 事件生效
test('T02', 'submitEvent 生效一次并更新状态/revision', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't02'), clock: fixedClock });
  const before = store.loadSnapshot();
  const res = store.submitEvent(event(), before.revision);
  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  const after = store.loadSnapshot();
  assert.equal(after.revision, 1);
  assert.equal(after.snapshot.state.valence, 0.1);
  assert.equal(after.snapshot.state.energy, 0.55);
  assert.deepEqual(after.snapshot.state.causeEventIds, ['e-synthetic-1']);
  store.close();
  return { revision: after.revision, valence: after.snapshot.state.valence, energy: after.snapshot.state.energy };
});

// T03 重复事件只一次
test('T03', '同一 eventId 重复提交不重复改状态/revision', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't03'), clock: fixedClock });
  const first = store.submitEvent(event(), 0);
  const second = store.submitEvent(event(), 0);
  const snap = store.loadSnapshot();
  assert.equal(first.applied, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  assert.equal(snap.revision, 1);
  assert.equal(snap.snapshot.state.valence, 0.1);
  store.close();
  return { duplicate: second.duplicate, revision: snap.revision };
});

// T04 并发冲突/重试
test('T04', '两个连接同 expectedRevision 只有一个成功，另一个 conflict 后可重试', () => {
  const dir = path.join(root, 't04');
  const a = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const b = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  assert.equal(a.loadSnapshot().revision, 0);
  assert.equal(b.loadSnapshot().revision, 0);
  const ra = a.submitEvent(event({ eventId: 'e-a' }), 0);
  const rb = b.submitEvent(event({ eventId: 'e-b' }), 0);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false);
  assert.equal(rb.conflict, true);
  const retry = b.submitEvent(event({ eventId: 'e-b' }), rb.revision);
  assert.equal(retry.ok, true);
  const snap = b.loadSnapshot();
  assert.equal(snap.revision, 2);
  assert.equal(snap.snapshot.recentEventIds.length, 2);
  a.close(); b.close();
  return { first: ra.applied, conflict: rb.conflict, retry: retry.applied, revision: snap.revision };
});

// T05 坏事件不覆盖
test('T05', '非法事件/超限 delta 被拒绝，快照不变', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't05'), clock: fixedClock });
  const before = store.loadSnapshot();
  const badReality = store.submitEvent({ ...event({ eventId: 'e-bad-1' }), reality: 'made-up' }, before.revision);
  const badDelta = store.submitEvent({ ...event({ eventId: 'e-bad-2', stateDelta: undefined }), stateDelta: { valence: 0.9 } }, before.revision);
  const after = store.loadSnapshot();
  assert.equal(badReality.ok, false);
  assert.equal(badDelta.ok, false);
  assert.equal(after.revision, 0);
  assert.equal(after.hash, before.hash);
  store.close();
  return { badReality: badReality.ok, badDelta: badDelta.ok, unchanged: after.hash === before.hash };
});

// T06 重启一致
test('T06', '关闭重开后快照 revision/hash 一致', () => {
  const dir = path.join(root, 't06');
  const a = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  a.submitEvent(event(), 0);
  const before = a.loadSnapshot();
  const beforeHash = hash(a.dbFile);
  a.close();
  const b = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const after = b.loadSnapshot();
  assert.equal(after.hash, before.hash);
  assert.equal(after.revision, before.revision);
  b.close();
  return { revision: after.revision, sameSnapshotHash: after.hash === before.hash };
});

// T07 决策幂等
test('T07', 'commitDecisionOutcome 幂等，重复 decisionId 不新增', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't07'), clock: fixedClock });
  store.loadSnapshot();
  const decision = {
    decisionId: 'd-1', intent: 'decline', engagement: 'brief', reasonCodes: ['boundary'],
    evidenceIds: ['b-1'], allowedActions: ['reply'], commitmentProposal: null,
    contextRevision: 0, expiresAt: '2026-10-29T16:05:00.000Z',
  };
  const a = store.commitDecisionOutcome(decision);
  const b = store.commitDecisionOutcome(decision);
  const snap = store.loadSnapshot();
  assert.equal(a.applied, true);
  assert.equal(b.duplicate, true);
  assert.deepEqual(snap.snapshot.recentDecisionIds, ['d-1']);
  store.close();
  return { first: a.applied, duplicate: b.duplicate };
});

// T08 scope 隔离
test('T08', 'global/group/private scope 状态互不串写', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't08'), clock: fixedClock });
  store.loadSnapshot();
  store.submitEvent(event({ eventId: 'e-group', scope: 'group:10001', stateDelta: { stress: 0.1 } }), 0);
  const global = store.loadSnapshot('global');
  const group = store.loadSnapshot('group:10001');
  assert.equal(global.snapshot.state.stress, 0.2);
  assert.equal(group.snapshot.state.stress, 0.3);
  store.close();
  return { globalStress: global.snapshot.state.stress, groupStress: group.snapshot.state.stress };
});

// T09 迁移 dry-run
test('T09', '迁移 dry-run 只产生计划，不写库、不 apply', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't09'), clock: fixedClock });
  const plan = store.dryRunMigration({ state: { valence: 0.2, energy: 0.5, stress: 0.1, attention: 0.6, updatedAt: '2026-10-29T15:00:00.000Z', causeEventIds: [] }, affinity: { '10001': 50 } });
  assert.equal(plan.applied, false);
  assert.equal(plan.writes, 0);
  assert.equal(plan.ok, true);
  assert.ok(plan.actions.some((a) => a.op === 'legacy.affinity.readonly'));
  store.close();
  return { applied: plan.applied, actions: plan.actions.map((a) => a.op) };
});

// T10 旧数据只读备份
test('T10', 'backupLegacyFile 复制旧文件且源文件字节不变', () => {
  const source = path.join(root, 't10-legacy.json');
  fs.writeFileSync(source, '{"old":true}\n');
  const before = hash(source);
  const out = backupLegacyFile(source, path.join(root, 't10-backup'));
  assert.equal(out.ok, true);
  assert.equal(hash(source), before);
  assert.equal(hash(out.backup), before);
  return { backup: path.basename(out.backup), sourceUnchanged: hash(source) === before };
});

// T11 坏库降级且不覆盖
test('T11', '坏 SQLite 文件返回 degraded，原文件不变，不写空状态', () => {
  const dir = path.join(root, 't11');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const file = path.join(dir, 'state', 'personality.sqlite');
  fs.writeFileSync(file, 'not-a-sqlite-db');
  const before = hash(file);
  const store = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const snap = store.loadSnapshot();
  const res = store.submitEvent(event(), 0);
  assert.equal(snap.ok, false);
  assert.equal(snap.degraded, true);
  assert.equal(res.ok, false);
  assert.equal(hash(file), before);
  store.close();
  return { status: snap.status, unchanged: hash(file) === before };
});

// T12 固定时钟
test('T12', 'clock 注入决定 updatedAt/recordedAt 处理', () => {
  const store = createPersonalityStore({ dataRoot: path.join(root, 't12'), clock: fixedClock });
  store.loadSnapshot();
  const res = store.submitEvent(event({ recordedAt: '2026-10-29T16:00:00.000Z' }), 0);
  const snap = store.loadSnapshot();
  assert.equal(res.ok, true);
  assert.equal(snap.snapshot.state.updatedAt, '2026-10-29T16:00:00.000Z');
  store.close();
  return { updatedAt: snap.snapshot.state.updatedAt };
});

// T13 版本不兼容（不覆盖有效库）
test('T13', 'SQLite schema_version 过高时 degraded，不写库', () => {
  const dir = path.join(root, 't13');
  const file = path.join(dir, 'state', 'personality.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE personality_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO personality_meta(key,value) VALUES(?,?)').run('schema_version', '99');
  db.close();
  const before = hash(file);
  const store = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const snap = store.loadSnapshot();
  assert.equal(snap.ok, false);
  assert.equal(snap.degraded, true);
  assert.equal(hash(file), before);
  store.close();
  return { status: snap.status, unchanged: hash(file) === before };
});

// T14 重启后重复事件仍幂等
test('T14', '重启后同一 eventId 仍只生效一次', () => {
  const dir = path.join(root, 't14');
  const a = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const first = a.submitEvent(event({ eventId: 'e-restart' }), 0);
  a.close();
  const b = createPersonalityStore({ dataRoot: dir, clock: fixedClock });
  const dup = b.submitEvent(event({ eventId: 'e-restart' }), 0);
  const snap = b.loadSnapshot();
  assert.equal(first.applied, true);
  assert.equal(dup.duplicate, true);
  assert.equal(snap.revision, 1);
  b.close();
  return { duplicate: dup.duplicate, revision: snap.revision };
});

// T15 导入/工厂不默认写 LIVE
test('T15', 'createPersonalityStore 缺 dataRoot 直接拒绝，导入不自动建库', () => {
  assert.throws(() => createPersonalityStore({}), /dataRoot/);
  assert.equal(fs.existsSync(path.join(candidate, 'qq-bridge', 'state', 'personality.sqlite')), false);
  return { rejected: true, liveDbCreated: false };
});

report.finishedAt = new Date().toISOString();
report.summary = {
  total: report.tests.length,
  passed: report.tests.filter((t) => t.ok).length,
  failed: report.tests.filter((t) => !t.ok).length,
  tempRoot: root,
};
const out = process.argv[2] || path.join(root, 'a02-test-report.json');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary));
for (const t of report.tests) console.log(`${t.ok ? 'PASS' : 'FAIL'} ${t.id} ${t.name}${t.ok ? '' : ` :: ${t.error}`}`);
if (report.summary.failed) process.exitCode = 1;

