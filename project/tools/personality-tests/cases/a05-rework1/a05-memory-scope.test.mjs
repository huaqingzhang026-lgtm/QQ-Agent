// A05 scope-aware memory retrieval: no cross-scope leak, stable ranking, no fixed 500 scan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const { openMemory, addEvent, searchEvents, hybridSearch, recentEvents, buildMemoryBrief } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const tmpDir = fs.mkdtempSync(path.join(root, 'a05-memory-'));
const db = openMemory(path.join(tmpDir, 'db.sqlite'));
const t0 = Date.parse('2026-11-01T00:00:00.000Z');
const add = (scope, text, at) => addEvent({ source: 'test', conversationKey: scope, actorId: '11', actorName: 'A', text, occurredAt: at, importance: 0.6, confidence: 0.9 });
add('private:1', '私聊里提到我在准备面试', t0);
add('group:1', '群里聊到面试和简历', t0 + 1000);
add('group:1', '群里闲聊天气', t0 + 2000);
add('group:2', '另一个群的旧面试话题', t0 + 3000);

test('search-events-requires-scope', () => {
  assert.deepEqual(searchEvents('面试', 10, { scopes: [] }), []);
  const priv = searchEvents('面试', 10, { scopes: ['private:1'] }).map((x) => x.conversation_key);
  const grp = searchEvents('面试', 10, { scopes: ['group:1'] }).map((x) => x.conversation_key);
  assert.deepEqual(priv, ['private:1']);
  assert.deepEqual(grp, ['group:1']);
  return { priv, grp };
});

test('hybrid-search-is-scope-filtered-and-stable', () => {
  const priv = [...new Set(hybridSearch('面试', 10, { scopes: ['private:1'] }).map((x) => x.conversation_key))];
  const grp = [...new Set(hybridSearch('面试', 10, { scopes: ['group:1'] }).map((x) => x.conversation_key))];
  assert.deepEqual(priv, ['private:1']);
  assert.deepEqual(grp, ['group:1']);
  const hits = hybridSearch('面试', 10, { scopes: ['group:1', 'group:2'] });
  assert.ok(hits.every((x) => Array.isArray(x.matchedBy) && x.matchedBy.length));
  const sorted = [...hits].sort((a, b) => (b.score - a.score) || (b.occurred_at - a.occurred_at) || (b.id - a.id));
  assert.deepEqual(hits, sorted);
  return { priv, grp, matchedBy: hits[0]?.matchedBy };
});

test('recent-events-respect-scope', () => {
  const priv = recentEvents({ scopes: ['private:1'] }).map((x) => x.conversation_key);
  const grp = recentEvents({ scopes: ['group:1'] }).map((x) => x.conversation_key);
  assert.ok(priv.length && priv.every((x) => x === 'private:1'));
  assert.ok(grp.length && grp.every((x) => x === 'group:1'));
  return { priv: priv.length, grp: grp.length };
});

test('memory-brief-does-not-leak-private-into-group', () => {
  const brief = buildMemoryBrief({ key: 'group:1', actorId: '11', query: '面试', scopes: ['group:1'] });
  assert.match(brief, /群里聊到面试和简历/);
  assert.equal(brief.includes('私聊里提到我在准备面试'), false);
  return { ok: true };
});

test('hybrid-search-does-not-use-unordered-fixed-500-window', () => {
  for (let i = 0; i < 600; i += 1) {
    add('group:1', `噪音事件 ${i} 没有查询词`, t0 + 10000 + i);
  }
  const hits = hybridSearch('面试', 10, { scopes: ['group:1'] });
  assert.ok(hits.length <= 10);
  assert.ok(hits.every((x) => x.matchedBy.includes('fts') || x.matchedBy.includes('timeline')));
  return { hits: hits.length };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05-memory-scope-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
