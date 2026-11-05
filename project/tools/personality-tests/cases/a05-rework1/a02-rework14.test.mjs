const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
// A02-rework1 反例回归：损坏记录、降级写保护、真实 Worker 快照一致性、备份不覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const candidate = CANDIDATE_ROOT;
const imp = (rel) => import(pathToFileURL(path.join(candidate, rel)).href);
const { createPersonalityStore, backupLegacyFile } = await imp('qq-bridge/src/personality-store.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a02-rework1-'));
const clock = () => Date.parse('2026-10-30T00:00:00.000Z');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { package: 'A02-rework2', startedAt: new Date().toISOString(), tests: [], summary: {} };

async function test(id, name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    report.tests.push({ id, name, ok: true, detail, ms: Date.now() - start });
  } catch (error) {
    report.tests.push({ id, name, ok: false, error: String(error?.stack ?? error), ms: Date.now() - start });
  }
}

function event(id, extras = {}) {
  return {
    eventId: id, source: 'synthetic', scope: 'global', actorId: 'synthetic',
    kind: 'test', occurredAt: '2026-10-30T00:00:00.000Z', recordedAt: '2026-10-30T00:00:00.000Z',
    reality: 'observed', status: 'completed', confidence: 1, evidenceRefs: ['e'],
    stateDelta: { energy: -0.05 }, ...extras,
  };
}

function fixture(name) {
  const dir = path.join(root, name);
  const store = createPersonalityStore({ dataRoot: dir, clock });
  assert.equal(store.loadSnapshot().ok, true);
  return { dir, store, file: store.dbFile };
}

function rawCounts(file) {
  const db = new DatabaseSync(file);
  const out = {
    persona: Number(db.prepare('SELECT COUNT(*) n FROM persona').get().n),
    events: Number(db.prepare('SELECT COUNT(*) n FROM events').get().n),
    decisions: Number(db.prepare('SELECT COUNT(*) n FROM decisions').get().n),
    snapshots: Number(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n),
  };
  try { out.revision = db.prepare('SELECT revision FROM snapshots WHERE scope=?').get('global')?.revision ?? null; } catch { out.revision = null; }
  db.close();
  return out;
}

// R01：有效库内坏 state_json / null / 数组 / 缺字段，都必须拒绝并保留现场。
for (const [tag, bad] of [
  ['invalid-json', '{broken'],
  ['null', 'null'],
  ['array', '[]'],
  ['missing-field', JSON.stringify({ valence: 0, stress: 0.2, attention: 0.7, updatedAt: '2026-10-29T16:00:00.000Z', causeEventIds: [] })],
]) {
  await test(`R01-${tag}`, `state_json=${tag} 不得默认成初始状态或覆盖`, () => {
    const x = fixture(`r01-${tag}`);
    assert.equal(x.store.submitEvent(event('before'), 0).applied, true);
    x.store.close();
    const raw = new DatabaseSync(x.file);
    raw.prepare('UPDATE snapshots SET state_json=? WHERE scope=?').run(bad, 'global');
    raw.close();
    const before = rawCounts(x.file);
    const s = createPersonalityStore({ dataRoot: x.dir, clock });
    const read = s.loadSnapshot();
    const write = s.submitEvent(event('after'), 1);
    s.close();
    const after = rawCounts(x.file);
    assert.equal(read.ok, false);
    assert.equal(read.degraded, true);
    assert.equal(write.ok, false);
    assert.equal(after.events, before.events);
    assert.equal(after.revision, before.revision);
    const check = new DatabaseSync(x.file);
    const row = check.prepare('SELECT state_json FROM snapshots WHERE scope=?').get('global');
    check.close();
    assert.equal(row.state_json, bad);
    return { readOk: read.ok, writeOk: write.ok, events: after.events, revision: after.revision };
  });
}

// R02：persona 损坏导致降级后，所有写入口拒绝；修复后显式 recover 才可恢复。
await test('R02-degraded-all-writes', 'persona 损坏后 submitEvent/commitDecisionOutcome 全部拒绝，修复后显式 recover', () => {
  const x = fixture('r02');
  x.store.close();
  const raw = new DatabaseSync(x.file);
  const good = raw.prepare('SELECT doc_json FROM persona WHERE active=1').get().doc_json;
  raw.prepare('UPDATE persona SET doc_json=?').run('{broken');
  raw.close();
  const before = rawCounts(x.file);
  const s = createPersonalityStore({ dataRoot: x.dir, clock });
  const read = s.loadSnapshot();
  const write = s.submitEvent(event('blocked'), 0);
  const decision = s.commitDecisionOutcome({
    decisionId: 'd-blocked', intent: 'decline', engagement: 'brief', reasonCodes: ['boundary'],
    evidenceIds: [], allowedActions: ['reply'], commitmentProposal: null,
    contextRevision: 0, expiresAt: '2026-10-30T00:05:00.000Z',
  });
  const after = rawCounts(x.file);
  assert.equal(read.degraded, true);
  assert.equal(write.ok, false);
  assert.equal(decision.ok, false);
  assert.deepEqual(after, before);
  // 修复现场后必须显式 recover，不能靠下一次 open 自动清标记。
  const repair = new DatabaseSync(x.file);
  repair.prepare('UPDATE persona SET doc_json=?').run(good);
  repair.close();
  assert.equal(s.getStatus().degraded !== null, true);
  const recovered = s.recover();
  assert.equal(recovered.ok, true);
  assert.equal(s.loadSnapshot().ok, true);
  assert.equal(s.submitEvent(event('after-repair'), 0).ok, true);
  s.close();
  return { writeOk: write.ok, decisionOk: decision.ok, recovered: recovered.ok };
});

// R03：快照缺失但事件已存在，不能新建默认快照。
await test('R03-snapshot-missing-with-events', '事件存在但 snapshot 缺失时降级且不补默认快照', () => {
  const x = fixture('r03');
  assert.equal(x.store.submitEvent(event('exists'), 0).applied, true);
  x.store.close();
  const raw = new DatabaseSync(x.file);
  raw.prepare('DELETE FROM snapshots WHERE scope=?').run('global');
  raw.close();
  const before = rawCounts(x.file);
  const s = createPersonalityStore({ dataRoot: x.dir, clock });
  const read = s.loadSnapshot();
  const write = s.submitEvent(event('new'), 0);
  s.close();
  const after = rawCounts(x.file);
  assert.equal(read.ok, false);
  assert.equal(read.degraded, true);
  assert.equal(write.ok, false);
  assert.equal(after.events, before.events);
  assert.equal(after.snapshots, 0);
  return { readOk: read.ok, events: after.events, snapshots: after.snapshots };
});

// R04：同毫秒/已有目标/不同源同 basename，旧备份字节必须保留。
await test('R04-backup-no-overwrite', '备份同毫秒碰撞不覆盖，已有目标保留，不同源同 basename 各自保留', () => {
  const dir = path.join(root, 'r04');
  const backupDir = path.join(dir, 'backup');
  const src = path.join(dir, 'legacy.json');
  fs.mkdirSync(backupDir, { recursive: true });
  const realNow = Date.now;
  let a, b;
  try {
    Date.now = () => Date.parse('2026-10-30T00:00:00.000Z');
    fs.writeFileSync(src, 'version-one');
    a = backupLegacyFile(src, backupDir);
    fs.writeFileSync(src, 'version-two');
    b = backupLegacyFile(src, backupDir);
  } finally { Date.now = realNow; }
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.backup, b.backup);
  assert.equal(fs.readFileSync(a.backup, 'utf8'), 'version-one');
  assert.equal(fs.readFileSync(b.backup, 'utf8'), 'version-two');

  // 预先放一个同 basename+时间戳的目标，copy 必须换名而不是覆盖。
  const occupiedName = `legacy.json.${Date.parse('2026-10-30T00:00:00.000Z')}-1.bak`;
  const occupied = path.join(backupDir, occupiedName);
  fs.writeFileSync(occupied, 'do-not-touch');
  let c;
  try {
    Date.now = () => Date.parse('2026-10-30T00:00:00.000Z');
    fs.writeFileSync(src, 'version-three');
    c = backupLegacyFile(src, backupDir);
  } finally { Date.now = realNow; }
  assert.equal(c.ok, true);
  assert.notEqual(c.backup, occupied);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'do-not-touch');
  assert.equal(fs.readFileSync(c.backup, 'utf8'), 'version-three');

  // 不同源、同 basename：不能串写。
  const d1 = path.join(dir, 'd1'); const d2 = path.join(dir, 'd2');
  fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d1, 'legacy.json'), 'source-a');
  fs.writeFileSync(path.join(d2, 'legacy.json'), 'source-b');
  const x = backupLegacyFile(path.join(d1, 'legacy.json'), backupDir);
  const y = backupLegacyFile(path.join(d2, 'legacy.json'), backupDir);
  assert.equal(x.ok && y.ok, true);
  assert.notEqual(x.backup, y.backup);
  assert.equal(fs.readFileSync(x.backup, 'utf8'), 'source-a');
  assert.equal(fs.readFileSync(y.backup, 'utf8'), 'source-b');
  return { first: path.basename(a.backup), second: path.basename(b.backup), occupiedKept: true };
});

// R05：真实 Worker 并发读写，检查每个快照内部一致。
await test('R05-worker-snapshot-coherent', '真实 Worker 写入 800 + 主线程读取 1200：revision/cause/recent 一致', async () => {
  const x = fixture('r05');
  const flag = new SharedArrayBuffer(16);
  const signal = new Int32Array(flag);
  const workerFile = path.join(root, 'r05-writer.mjs');
  fs.writeFileSync(workerFile, `import { workerData, parentPort } from 'node:worker_threads';
import { createPersonalityStore } from ${JSON.stringify(pathToFileURL(path.join(candidate, 'qq-bridge/src/personality-store.mjs')).href)};
const s = new Int32Array(workerData.flag);
const store = createPersonalityStore({ dataRoot: workerData.dir, clock: () => Date.parse('2026-10-30T00:00:00.000Z') });
store.loadSnapshot();
Atomics.store(s, 0, 1); Atomics.notify(s, 0);
while (Atomics.load(s, 1) === 0) Atomics.wait(s, 1, 0, 1000);
let applied = 0;
for (let i = 0; i < 800; i++) {
  const r = store.submitEvent({ eventId: 'race-' + i, source: 'synthetic', scope: 'global', actorId: 'synthetic', kind: 'test', occurredAt: '2026-10-30T00:00:00.000Z', recordedAt: '2026-10-30T00:00:00.000Z', reality: 'observed', status: 'completed', confidence: 1, evidenceRefs: ['e'], stateDelta: { energy: 0 } }, i);
  if (!r.ok) throw new Error(JSON.stringify(r));
  applied++;
}
store.close();
parentPort.postMessage({ applied });`, 'utf8');
  const worker = new Worker(workerFile, { workerData: { dir: x.dir, flag } });
  const done = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  const until = Date.now() + 15000;
  while (!Atomics.load(signal, 0) && Date.now() < until) Atomics.wait(signal, 0, 0, 100);
  if (!Atomics.load(signal, 0)) { await worker.terminate(); throw new Error('worker init timeout'); }
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1);
  let mismatches = 0; let first = null;
  for (let i = 0; i < 1200; i++) {
    const r = x.store.loadSnapshot();
    if (!r.ok) throw new Error('read failed: ' + r.error);
    const cause = r.snapshot.state.causeEventIds.at(-1) ?? null;
    const recent = r.snapshot.recentEventIds[0] ?? null;
    const expected = r.revision === 0 ? null : `race-${r.revision - 1}`;
    if (cause !== recent || cause !== expected) { mismatches++; if (!first) first = { revision: r.revision, cause, recent, expected }; }
  }
  const finished = await done;
  const final = x.store.loadSnapshot();
  x.store.close();
  assert.equal(finished.applied, 800);
  assert.equal(final.revision, 800);
  assert.equal(mismatches, 0);
  return { reads: 1200, writerApplied: finished.applied, finalRevision: final.revision, mismatches, first };
});

// R06：真实双写入者正向控制，冲突方重试不丢更新。
await test('R06-double-writer-retry', '两个 Worker 从 revision 0 写入，冲突方重试后 revision=2/energy=0.4', async () => {
  const x = fixture('r06');
  const flag = new SharedArrayBuffer(16);
  const signal = new Int32Array(flag);
  const workerFile = path.join(root, 'r06-writer.mjs');
  fs.writeFileSync(workerFile, `import { workerData, parentPort } from 'node:worker_threads';
import { createPersonalityStore } from ${JSON.stringify(pathToFileURL(path.join(candidate, 'qq-bridge/src/personality-store.mjs')).href)};
const s = new Int32Array(workerData.flag);
const store = createPersonalityStore({ dataRoot: workerData.dir, clock: () => Date.parse('2026-10-30T00:00:00.000Z') });
store.loadSnapshot(); Atomics.add(s, 0, 1); Atomics.notify(s, 0);
while (Atomics.load(s, 1) === 0) Atomics.wait(s, 1, 0, 1000);
const e = { eventId: 'writer-' + workerData.id, source: 'synthetic', scope: 'global', actorId: 'synthetic', kind: 'test', occurredAt: '2026-10-30T00:00:00.000Z', recordedAt: '2026-10-30T00:00:00.000Z', reality: 'observed', status: 'completed', confidence: 1, evidenceRefs: ['e'], stateDelta: { energy: -0.1 } };
const first = store.submitEvent(e, 0);
let retry = null;
if (first.conflict) retry = store.submitEvent(e, first.revision);
store.close(); parentPort.postMessage({ first, retry });`, 'utf8');
  const workers = [1, 2].map((id) => new Worker(workerFile, { workerData: { id, dir: x.dir, flag } }));
  const promises = workers.map((w) => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); }));
  const limit = Date.now() + 15000;
  while (Atomics.load(signal, 0) < 2 && Date.now() < limit) Atomics.wait(signal, 0, Atomics.load(signal, 0), 100);
  if (Atomics.load(signal, 0) < 2) { await Promise.all(workers.map((w) => w.terminate())); throw new Error('writers init timeout'); }
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1);
  const results = await Promise.all(promises);
  const snap = x.store.loadSnapshot();
  x.store.close();
  assert.equal(results.filter((r) => r.first.conflict).length, 1);
  assert.equal(results.filter((r) => r.retry?.applied).length, 1);
  assert.equal(snap.revision, 2);
  assert.equal(snap.snapshot.state.energy, 0.4);
  return { conflicts: 1, retries: 1, revision: snap.revision, energy: snap.snapshot.state.energy };
});

// R07：legacy schema=1 无 initialized 标志 + private 历史 + persona 丢失，不能重种。
await test('R07-legacy-private-persona-missing', 'schema=1 无标志的 private 历史缺 persona 不补默认', () => {
  const x = fixture('r07');
  assert.equal(x.store.submitEvent(event('private-history', { scope: 'private:1' }), 0).applied, true);
  x.store.close();
  const raw = new DatabaseSync(x.file);
  raw.prepare('DELETE FROM persona').run();
  raw.prepare('DELETE FROM personality_meta WHERE key=?').run('initialized');
  raw.close();
  const before = rawCounts(x.file);
  const s = createPersonalityStore({ dataRoot: x.dir, clock });
  const read = s.loadSnapshot('private:1');
  s.close();
  const after = rawCounts(x.file);
  assert.equal(read.ok, false);
  assert.equal(after.persona, 0);
  assert.equal(after.events, before.events);
  return { readOk: read.ok, personaRows: after.persona, events: after.events };
});

// R08：legacy schema=1 无标志 + 决策历史 + 快照丢失，不能补默认快照。
await test('R08-legacy-decisions-snapshot-missing', 'schema=1 无标志的决策历史缺 snapshot 不补默认', () => {
  const x = fixture('r08');
  assert.equal(x.store.commitDecisionOutcome({
    decisionId: 'legacy-d1', intent: 'decline', engagement: 'brief', reasonCodes: ['boundary'],
    evidenceIds: [], allowedActions: ['reply'], commitmentProposal: null,
    contextRevision: 0, expiresAt: '2026-10-30T00:05:00.000Z',
  }, 0).applied, true);
  x.store.close();
  const raw = new DatabaseSync(x.file);
  raw.prepare('DELETE FROM snapshots').run();
  raw.prepare('DELETE FROM personality_meta WHERE key=?').run('initialized');
  raw.close();
  const before = rawCounts(x.file);
  const s = createPersonalityStore({ dataRoot: x.dir, clock });
  const read = s.loadSnapshot();
  s.close();
  const after = rawCounts(x.file);
  assert.equal(read.ok, false);
  assert.equal(after.snapshots, 0);
  assert.equal(after.decisions, before.decisions);
  return { readOk: read.ok, snapshots: after.snapshots, decisions: after.decisions };
});

// R11：global state 坏记录未修复时 recover 必须失败，且不能写事件/决策。
await test('R11-global-state-recover-rejected', 'global 坏 state 未修复时 recover 失败且写入不变', () => {
  const x = fixture('r11');
  assert.equal(x.store.submitEvent(event('before-r11'), 0).applied, true);
  x.store.close();
  const raw = new DatabaseSync(x.file);
  const good = raw.prepare('SELECT state_json FROM snapshots WHERE scope=?').get('global').state_json;
  raw.prepare('UPDATE snapshots SET state_json=? WHERE scope=?').run('{broken', 'global');
  raw.close();
  const before = rawCounts(x.file);
  const s = createPersonalityStore({ dataRoot: x.dir, clock });
  const read = s.loadSnapshot();
  const recovery = s.recover();
  const write = s.submitEvent(event('after-r11'), 1);
  const decision = s.commitDecisionOutcome({
    decisionId: 'd-r11', intent: 'decline', engagement: 'brief', reasonCodes: ['boundary'],
    evidenceIds: [], allowedActions: ['reply'], commitmentProposal: null,
    contextRevision: 0, expiresAt: '2026-10-30T00:05:00.000Z',
  });
  s.close();
  const after = rawCounts(x.file);
  assert.equal(read.ok, false);
  assert.equal(recovery.ok, false);
  assert.equal(write.ok, false);
  assert.equal(decision.ok, false);
  assert.deepEqual(after, before);
  const check = new DatabaseSync(x.file);
  const row = check.prepare('SELECT state_json FROM snapshots WHERE scope=?').get('global');
  check.close();
  assert.equal(row.state_json, '{broken');
  return { readOk: read.ok, recoveryOk: recovery.ok, writeOk: write.ok, decisionOk: decision.ok, revision: after.revision };
});

// R09：健康 legacy schema=1 无标志库，应补标志而不改数据。
await test('R09-legacy-marker-upgrade', '健康旧库无 initialized 标志时补标志，不重写人格/状态', () => {
  const x = fixture('r09');
  assert.equal(x.store.submitEvent(event('legacy-event'), 0).applied, true);
  x.store.close();
  const raw = new DatabaseSync(x.file);
  raw.prepare('DELETE FROM personality_meta WHERE key=?').run('initialized');
  const before = rawCounts(x.file);
  const personaBefore = raw.prepare('SELECT COUNT(*) n FROM persona').get().n;
  raw.close();
  const s = createPersonalityStore({ dataRoot: x.dir, clock });
  const read = s.loadSnapshot();
  s.close();
  const check = new DatabaseSync(x.file);
  const marker = check.prepare('SELECT value FROM personality_meta WHERE key=?').get('initialized')?.value;
  const personaAfter = check.prepare('SELECT COUNT(*) n FROM persona').get().n;
  check.close();
  const after = rawCounts(x.file);
  assert.equal(read.ok, true);
  assert.equal(marker, '1');
  assert.equal(personaAfter, personaBefore);
  assert.equal(after.events, before.events);
  assert.equal(after.revision, before.revision);
  return { marker, personaBefore, personaAfter, revision: after.revision };
});

// R10：两个真实 Worker 同时首次初始化同一空库，不产生半初始化/双 persona。
await test('R10-concurrent-first-init', '两个 Worker 并发首次初始化：两边都成功且只有一份 persona/global snapshot', async () => {
  const dir = path.join(root, 'r10');
  const workerFile = path.join(root, 'r10-init.mjs');
  fs.writeFileSync(workerFile, `import { workerData, parentPort } from 'node:worker_threads';
import { createPersonalityStore } from ${JSON.stringify(pathToFileURL(path.join(candidate, 'qq-bridge/src/personality-store.mjs')).href)};
const s = createPersonalityStore({ dataRoot: workerData.dir, clock: () => Date.parse('2026-10-30T00:00:00.000Z') });
const r = s.loadSnapshot(); s.close(); parentPort.postMessage({ ok: r.ok, error: r.error ?? null });`, 'utf8');
  const workers = [1, 2].map((id) => new Worker(workerFile, { workerData: { dir } }));
  const results = await Promise.all(workers.map((w) => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); })));
  const raw = new DatabaseSync(path.join(dir, 'state', 'personality.sqlite'));
  const persona = Number(raw.prepare('SELECT COUNT(*) n FROM persona').get().n);
  const snapshots = Number(raw.prepare('SELECT COUNT(*) n FROM snapshots').get().n);
  const marker = raw.prepare('SELECT value FROM personality_meta WHERE key=?').get('initialized')?.value;
  raw.close();
  assert.equal(results.every((r) => r.ok), true, JSON.stringify(results));
  assert.equal(persona, 1);
  assert.equal(snapshots, 1);
  assert.equal(marker, '1');
  return { results, persona, snapshots, marker };
});

if (process.argv.includes('--async-selfcheck')) {
  await test('SELF-CHECK-async-failure', '故意异步失败必须进入 failed 且退出非零', async () => {
    await Promise.resolve();
    assert.fail('intentional async failure');
  });
}

report.finishedAt = new Date().toISOString();
report.summary = { total: report.tests.length, passed: report.tests.filter((t) => t.ok).length, failed: report.tests.filter((t) => !t.ok).length, tempRoot: root };
const out = process.argv[2] || path.join(process.env.A00_DATA_ROOT || root, 'a02-rework14-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
for (const t of report.tests) console.log(`${t.ok ? 'PASS' : 'FAIL'} ${t.id} ${t.name}${t.ok ? '' : ` :: ${t.error}`}`);
if (report.summary.failed) process.exitCode = 1;
