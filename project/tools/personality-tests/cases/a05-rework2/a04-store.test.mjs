// A04 关系存储：持久化、幂等、scope 证据过滤、v1→v2 迁移、坏数据降级。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const { createPersonalityStore } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-store.mjs')).href);
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
function tmp(tag) { return fs.mkdtempSync(path.join(root, 'a04-store-' + tag + '-')); }
function cleanup(store) { try { store?.close(); } catch {} }
function makeEvent({ id, scope = 'group:1', actorId = '2', kind = 'harassment.insult', evidence = ['m1'], occurredAt = '2026-11-04T00:00:00.000Z', omitRelationship = false }) {
  const eff = affect.effectFor(kind);
  return {
    eventId: id, source: 'test', scope, actorId, kind,
    occurredAt, recordedAt: '2026-11-04T00:00:01.000Z', reality: 'observed', status: 'completed',
    evidenceRefs: evidence, confidence: 0.95, payload: { conversationKey: scope },
    stateDelta: eff.stateDelta, relationshipDelta: omitRelationship ? null : eff.relationshipDelta,
  };
}

test('relationship-persists-across-restart', () => {
  const dir = tmp('persist');
  let store = createPersonalityStore({ dataRoot: dir });
  const snap = store.loadSnapshot('group:1');
  const r = store.submitEvent(makeEvent({ id: 'e1' }), snap.revision);
  assert.equal(r.ok, true);
  assert.equal(r.relationshipRevision, 1);
  store.close();
  store = createPersonalityStore({ dataRoot: dir });
  const loaded = store.loadRelationship('2', { scope: 'group:1' });
  assert.equal(loaded.ok, true);
  assert.ok(loaded.relationship.trust < 0.25);
  assert.equal(loaded.relationship.tension, 0.12);
  assert.deepEqual(loaded.evidenceIds, ['e1']);
  cleanup(store);
  return { trust: loaded.relationship.trust, evidenceIds: loaded.evidenceIds };
});

test('relationship-delta-is-idempotent-by-event-id', () => {
  const dir = tmp('idem');
  const store = createPersonalityStore({ dataRoot: dir });
  const snap = store.loadSnapshot('group:1');
  const e = makeEvent({ id: 'e-dup' });
  assert.equal(store.submitEvent(e, snap.revision).applied, true);
  const after = store.loadSnapshot('group:1');
  const second = store.submitEvent(e, after.revision);
  assert.equal(second.duplicate, true);
  const rel = store.loadRelationship('2', { scope: 'group:1' });
  assert.equal(rel.relationship.tension, 0.12);
  cleanup(store);
  return { duplicate: second.duplicate, tension: rel.relationship.tension };
});

test('scope-evidence-is-filtered-without-splitting-metrics', () => {
  const dir = tmp('scope');
  const store = createPersonalityStore({ dataRoot: dir });
  const g = store.loadSnapshot('group:1');
  store.submitEvent(makeEvent({ id: 'evt-group', scope: 'group:1', evidence: ['g1'] }), g.revision);
  const p = store.loadSnapshot('private:2');
  store.submitEvent(makeEvent({ id: 'evt-private', scope: 'private:2', evidence: ['p1'] }), p.revision);
  const groupView = store.loadRelationship('2', { scope: 'group:1' });
  const privateView = store.loadRelationship('2', { scope: 'private:2' });
  assert.deepEqual(groupView.evidenceIds, ['evt-group']);
  assert.deepEqual(privateView.evidenceIds, ['evt-private']);
  assert.deepEqual(groupView.relationship, privateView.relationship);
  assert.equal(groupView.relationship.causeEventIds.includes('evt-private'), true);
  cleanup(store);
  return { group: groupView.evidenceIds, private: privateView.evidenceIds, metricsShared: true };
});

test('old-v1-database-gets-additive-a04-schema-without-losing-events', () => {
  const dir = tmp('migrate');
  let store = createPersonalityStore({ dataRoot: dir });
  const snap = store.loadSnapshot('group:1');
  store.submitEvent(makeEvent({ id: 'old-event', omitRelationship: true }), snap.revision);
  const dbFile = store.dbFile;
  store.close();
  const raw = new DatabaseSync(dbFile);
  raw.exec('DROP TABLE relationships');
  raw.exec('ALTER TABLE events DROP COLUMN relationship_delta_json');
  raw.prepare('UPDATE personality_meta SET value=? WHERE key=?').run('1', 'schema_version');
  const before = raw.prepare('SELECT COUNT(*) n FROM events').get().n;
  raw.close();
  store = createPersonalityStore({ dataRoot: dir });
  const loaded = store.loadSnapshot('group:1');
  assert.equal(loaded.ok, true);
  assert.equal(store.getStatus().schemaVersion, 1);
  const check = new DatabaseSync(dbFile);
  const cols = check.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  const relTable = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relationships'").get();
  const meta = check.prepare('SELECT value FROM personality_meta WHERE key=?').get('schema_version');
  const after = check.prepare('SELECT COUNT(*) n FROM events').get().n;
  check.close();
  assert.equal(cols.includes('relationship_delta_json'), true);
  assert.ok(relTable);
  assert.equal(meta.value, '1');
  assert.equal(after, before);
  cleanup(store);
  return { before, after, schemaVersion: meta.value };
});

test('invalid-relationship-json-degrades-instead-of-overwriting', () => {
  const dir = tmp('bad');
  const store = createPersonalityStore({ dataRoot: dir });
  const snap = store.loadSnapshot('group:1');
  store.submitEvent(makeEvent({ id: 'e-bad' }), snap.revision);
  const dbFile = store.dbFile;
  store.close();
  const raw = new DatabaseSync(dbFile);
  raw.prepare('UPDATE relationships SET relationship_json=? WHERE actor_id=?').run('{broken', '2');
  raw.close();
  const reopened = createPersonalityStore({ dataRoot: dir });
  const read = reopened.loadSnapshot('group:1');
  assert.equal(read.ok, false);
  const status = reopened.getStatus();
  assert.equal(status.status, 'degraded');
  const check = new DatabaseSync(dbFile);
  const kept = check.prepare('SELECT relationship_json FROM relationships WHERE actor_id=?').get('2').relationship_json;
  check.close();
  assert.equal(kept, '{broken');
  cleanup(reopened);
  return { degraded: status.status, kept: kept.slice(0, 8) };
});

test('event-without-relationship-delta-does-not-create-row', () => {
  const dir = tmp('nodelt');
  const store = createPersonalityStore({ dataRoot: dir });
  const snap = store.loadSnapshot('group:1');
  const e = makeEvent({ id: 'e-nodelta' });
  e.relationshipDelta = null;
  const r = store.submitEvent(e, snap.revision);
  assert.equal(r.ok, true);
  assert.equal(r.relationshipRevision, null);
  const loaded = store.loadSnapshot('group:1');
  assert.deepEqual(loaded.snapshot.relationships, {});
  cleanup(store);
  return { relationships: 0 };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-store-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
