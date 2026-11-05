// A04 affinity 适配器：只读投影、证据要求、待核实笔记、候选请求不直接改维度。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
function workspace(tag) {
  const dir = fs.mkdtempSync(path.join(root, 'a04-aff-' + tag + '-'));
  fs.mkdirSync(path.join(dir, 'qq-bridge', 'state'), { recursive: true });
  return dir;
}
function writeProjection(dir, people) {
  fs.writeFileSync(path.join(dir, 'qq-bridge', 'state', 'affinity-projection.json'), JSON.stringify({ version: 1, updatedAt: '2026-11-04T00:00:00.000Z', people }, null, 2));
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
const originalCwd = process.cwd();
const dir = workspace('plugin');
writeProjection(dir, {
  12345: { trust: 0.4, closeness: 0.2, tension: 0.1, familiarity: 0.3, tier: '路人', score: 25, updatedAt: '2026-11-04T00:00:00.000Z', notes: ['私聊秘密：住在某小区'], privateText: '不该出现的原文' },
});
process.chdir(dir);
const plugin = await import(pathToFileURL(path.join(C, 'bundles/pluto-affinity/index.js')).href);
const adapter = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affinity-adapter.mjs')).href);

await test('get-is-read-only-and-leaks-no-notes-or-private-text', async () => {
  const text = await plugin.HANDLERS.affinity_get({ uin: '12345' });
  assert.match(text, /信任/);
  assert.equal(text.includes('私聊秘密'), false);
  assert.equal(text.includes('不该出现的原文'), false);
  return { text: text.split('\n')[0] };
});

await test('bump-without-evidence-only-creates-pending-note', async () => {
  const text = await plugin.HANDLERS.affinity_bump({ uin: '12345', key: 'group:1', delta: 5, reason: '感觉不错' });
  assert.match(text, /未改真实关系/);
  assert.equal(fs.existsSync(path.join(dir, 'qq-bridge/state/affinity-requests.json')), false);
  const pending = readJson(path.join(dir, 'qq-bridge/state/affinity-pending.json'), []);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'unverified-no-evidence');
  assert.equal(pending[0].delta, 5);
  return { pending: pending.length };
});

await test('bump-with-evidence-writes-bounded-request-only', async () => {
  const before = fs.readFileSync(path.join(dir, 'qq-bridge/state/affinity-projection.json'), 'utf8');
  const text = await plugin.HANDLERS.affinity_bump({ uin: '12345', key: 'group:1', delta: 0.9, reason: '帮了忙', evidenceIds: ['m1', 'm2'] });
  assert.match(text, /候选/);
  const queue = readJson(path.join(dir, 'qq-bridge/state/affinity-requests.json'), []);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].delta, adapter.MAX_OBSERVATION_DELTA);
  assert.deepEqual(queue[0].evidenceIds, ['m1', 'm2']);
  assert.equal(fs.readFileSync(path.join(dir, 'qq-bridge/state/affinity-projection.json'), 'utf8'), before);
  return { delta: queue[0].delta, evidence: queue[0].evidenceIds };
});

await test('set-and-note-never-change-relationship-projection', async () => {
  const before = fs.readFileSync(path.join(dir, 'qq-bridge/state/affinity-projection.json'), 'utf8');
  const setText = await plugin.HANDLERS.affinity_set({ uin: '12345', score: 100 });
  const noteText = await plugin.HANDLERS.affinity_note({ uin: '12345', text: '喜欢猫' });
  assert.match(setText, /停用/);
  assert.match(noteText, /待核实/);
  assert.equal(fs.readFileSync(path.join(dir, 'qq-bridge/state/affinity-projection.json'), 'utf8'), before);
  const pending = readJson(path.join(dir, 'qq-bridge/state/affinity-pending.json'), []);
  assert.ok(pending.some((x) => x.kind === 'rejected-direct-set'));
  assert.ok(pending.some((x) => x.kind === 'note'));
  return { pending: pending.length };
});

await test('observation-event-is-bounded-and-requires-evidence', () => {
  const event = adapter.observationEventFor({ request: { id: 'r1', delta: 9, at: Date.now(), reason: 'x' }, actorId: '2', scope: 'group:1', evidenceRefs: ['m1'] });
  assert.equal(event.kind, 'relationship.observation');
  assert.ok(Math.abs(event.relationshipDelta.trust) <= adapter.MAX_OBSERVATION_DELTA);
  assert.deepEqual(event.evidenceRefs, ['m1']);
  const bad = adapter.normalizeBumpRequest({ uin: '12345', key: 'group:1', delta: 1, evidenceIds: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'evidence-required');
  return { trustDelta: event.relationshipDelta.trust };
});

await test('list-does-not-include-notes', async () => {
  const text = await plugin.HANDLERS.affinity_list({ limit: 10 });
  assert.match(text, /关系概况/);
  assert.equal(text.includes('私聊秘密'), false);
  return { text: text.split('\n')[0] };
});

process.chdir(originalCwd);
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-affinity-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
