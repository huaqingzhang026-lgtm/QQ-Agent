// A04-rework1 F01：两个真实 Worker 同时提交同一事实，只应用一次。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const { createPersonalityStore } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-store.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
const dataRoot = fs.mkdtempSync(path.join(root, 'f01-worker-'));
const seed = createPersonalityStore({ dataRoot }); seed.loadSnapshot('group:1'); seed.close();
const event = {
  eventId: 'evt:group:1:11:casual:m1', source: 'qq', scope: 'group:1', actorId: '11', kind: 'casual.chat',
  occurredAt: '2026-11-04T00:00:00.000Z', recordedAt: '2026-11-04T00:00:00.000Z',
  reality: 'observed', status: 'completed', confidence: 0.6, evidenceRefs: ['m1'],
  payload: { conversationKey: 'group:1', messageId: 'm1' }, stateDelta: null,
  relationshipDelta: { familiarity: 0.002 },
};
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(workerData.store).href);
  const store = mod.createPersonalityStore({ dataRoot: workerData.dataRoot });
  let applied = 0, duplicate = 0, conflict = 0;
  for (let i = 0; i < 6; i++) {
    const snap = store.loadSnapshot('group:1');
    const r = store.submitEvent(workerData.event, snap.revision);
    if (r.applied) { applied++; break; }
    if (r.duplicateFact || r.duplicate) { duplicate++; break; }
    if (r.conflict) { conflict++; continue; }
    throw new Error('unexpected submit result ' + JSON.stringify(r));
  }
  store.close();
  parentPort.postMessage({ applied, duplicate, conflict });
})().catch((error) => { throw error; });
`;
function runWorker() {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerCode, { eval: true, workerData: { store: path.join(C, 'qq-bridge/src/personality-store.mjs'), dataRoot, event } });
    w.once('message', resolve);
    w.once('error', reject);
  });
}
const results = await Promise.all([runWorker(), runWorker()]);
const store = createPersonalityStore({ dataRoot });
const rel = store.loadRelationship('11', { scope: 'group:1' });
const counts = store.loadSnapshot('group:1');
store.close();
assert.equal(results.reduce((n, r) => n + r.applied, 0), 1);
assert.equal(results.reduce((n, r) => n + r.duplicate, 0), 1);
assert.equal(rel.revision, 1);
assert.equal(rel.relationship.familiarity, 0.002);
assert.equal(rel.relationship.trust, 0.25);
assert.equal(counts.snapshot.revision, 1);
const out = { results, relationship: rel, snapshotRevision: counts.snapshot.revision, summary: { total: 4, passed: 4, failed: 0 } };
fs.writeFileSync(path.join(root, 'a04-f01-worker-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
console.log('PASS two-workers-same-fact-once');
