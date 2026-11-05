const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
// A02-rework4：拒绝路径的新 scope 原子性、健康新 scope、重复/冲突/loadSnapshot 创建路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const candidate = CANDIDATE_ROOT;
const { createPersonalityStore } = await import(pathToFileURL(path.join(candidate, 'qq-bridge/src/personality-store.mjs')).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a02-rework4-'));
const clock = () => Date.parse('2026-10-30T00:00:00.000Z');
const time = '2026-10-30T00:00:00.000Z';
const ev = (id, scope = 'global', extra = {}) => ({ eventId: id, scope, kind: 'test', source: 'synthetic', actorId: 'synthetic', occurredAt: time, recordedAt: time, reality: 'observed', status: 'completed', confidence: 1, evidenceRefs: ['e'], stateDelta: { energy: -0.01 }, ...extra });
const report = { package: 'A02-rework4', tests: [], summary: {} };
const tests = [];
async function test(id, name, fn) {
  try { tests.push({ id, name, ok: true, detail: await fn() }); }
  catch (error) { tests.push({ id, name, ok: false, error: String(error?.stack ?? error) }); }
}
function fixture(name) {
  const dir = path.join(root, name);
  const s = createPersonalityStore({ dataRoot: dir, clock });
  assert.equal(s.loadSnapshot().ok, true);
  return { dir, s, file: s.dbFile };
}
function raw(file, fn) { const d = new DatabaseSync(file); try { return fn(d); } finally { d.close(); } }
function snapshots(file) { return raw(file, (d) => d.prepare('SELECT scope, revision, state_json FROM snapshots ORDER BY scope').all()); }
function counts(file) { return raw(file, (d) => ({ persona: d.prepare('SELECT COUNT(*) n FROM persona').get().n, snapshots: d.prepare('SELECT COUNT(*) n FROM snapshots').get().n, events: d.prepare('SELECT COUNT(*) n FROM events').get().n, decisions: d.prepare('SELECT COUNT(*) n FROM decisions').get().n })); }

for (const kind of ['persona', 'state']) {
  await test(`HOT-${kind}`, `热损坏 ${kind} 时新 private/group 写不留下快照`, () => {
    const x = fixture(`hot-${kind}`);
    raw(x.file, (d) => kind === 'persona'
      ? d.prepare('UPDATE persona SET doc_json=?').run('{broken')
      : d.prepare('UPDATE snapshots SET state_json=? WHERE scope=?').run('{broken', 'global'));
    const before = { snapshots: snapshots(x.file), counts: counts(x.file) };
    const p = x.s.submitEvent(ev('hot-private', 'private:700'), 0);
    const g = x.s.submitEvent(ev('hot-group', 'group:700'), 0);
    const after = { snapshots: snapshots(x.file), counts: counts(x.file) };
    x.s.close();
    assert.equal(p.ok, false);
    assert.equal(g.ok, false);
    assert.deepEqual(after, before);
    assert.equal(after.snapshots.find((r) => r.scope === 'private:700'), undefined);
    assert.equal(after.snapshots.find((r) => r.scope === 'group:700'), undefined);
    return { pOk: p.ok, gOk: g.ok, snapshots: after.snapshots.map((r) => r.scope) };
  });
}

await test('HEALTHY-NEW', '健康库新建 private/group 成功并写入，重启可读', () => {
  const x = fixture('healthy-new');
  const p = x.s.submitEvent(ev('new-private', 'private:701'), 0);
  const g = x.s.submitEvent(ev('new-group', 'group:701'), 0);
  assert.equal(p.applied, true);
  assert.equal(g.applied, true);
  const before = snapshots(x.file);
  x.s.close();
  const r = createPersonalityStore({ dataRoot: x.dir, clock });
  const ps = r.loadSnapshot('private:701');
  const gs = r.loadSnapshot('group:701');
  r.close();
  assert.equal(ps.ok, true);
  assert.equal(gs.ok, true);
  assert.equal(ps.snapshot.revision, 1);
  assert.equal(gs.snapshot.revision, 1);
  assert.ok(before.some((x) => x.scope === 'private:701' && x.revision === 1));
  assert.ok(before.some((x) => x.scope === 'group:701' && x.revision === 1));
  return { privateScope: ps.snapshot.scope, groupScope: gs.snapshot.scope, privateRevision: ps.snapshot.revision, groupRevision: gs.snapshot.revision };
});

await test('LOAD-FAIL-NO-SCOPE', 'loadSnapshot 新 scope 在热损坏时失败且不创建默认快照', () => {
  const x = fixture('load-fail');
  raw(x.file, (d) => d.prepare('UPDATE persona SET doc_json=?').run('{broken'));
  const before = snapshots(x.file);
  const r = x.s.loadSnapshot('private:702');
  const after = snapshots(x.file);
  x.s.close();
  assert.equal(r.ok, false);
  assert.deepEqual(after, before);
  return { loadOk: r.ok, scopes: after.map((s) => s.scope) };
});

await test('LOAD-HEALTHY-NEW', '健康库 loadSnapshot 新 scope 才创建默认快照', () => {
  const x = fixture('load-healthy');
  const r = x.s.loadSnapshot('group:702');
  const scopes = snapshots(x.file);
  x.s.close();
  assert.equal(r.ok, true);
  assert.ok(scopes.some((s) => s.scope === 'group:702' && s.revision === 0));
  return { loadOk: r.ok, scopes: scopes.map((s) => s.scope) };
});

await test('DUPLICATE-NO-SCOPE', '重复 eventId 不创建新 scope', () => {
  const x = fixture('duplicate');
  assert.equal(x.s.submitEvent(ev('dup-1', 'global'), 0).applied, true);
  const before = snapshots(x.file);
  const dup = x.s.submitEvent(ev('dup-1', 'global'), 0);
  const after = snapshots(x.file);
  x.s.close();
  assert.equal(dup.duplicate, true);
  assert.deepEqual(after, before);
  return { duplicate: dup.duplicate, scopes: after.map((s) => s.scope) };
});

await test('CONFLICT-NO-SCOPE', '新 scope expectedRevision 非 0 冲突且不创建快照', () => {
  const x = fixture('conflict');
  const before = snapshots(x.file);
  const r = x.s.submitEvent(ev('conflict-1', 'private:703'), 1);
  const after = snapshots(x.file);
  x.s.close();
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.deepEqual(after, before);
  return { conflict: r.conflict, revision: r.revision, scopes: after.map((s) => s.scope) };
});

report.tests = tests;
report.summary = { total: tests.length, passed: tests.filter((t) => t.ok).length, failed: tests.filter((t) => !t.ok).length, tempRoot: root };
const out = process.argv[2] || path.join(process.env.A00_DATA_ROOT || root, 'a02-atomicity7-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
for (const t of tests) console.log(`${t.ok ? 'PASS' : 'FAIL'} ${t.id} ${t.name}${t.ok ? '' : ` :: ${t.error}`}`);
if (report.summary.failed) process.exitCode = 1;
