// A05-rework1 F01：所有记忆注入链的 scope 有效性。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const knowledgeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-knowledge.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, 'a05r1-permission-'));
const db = storeMod.openMemory(path.join(tmp, 'memory.sqlite'));
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const now = Date.parse('2026-11-05T00:00:00.000Z');

test('people-summary-and-names-respect-scope', () => {
  storeMod.upsertPerson({ qq: '11', summary: 'PRIVATE_PERSON_MARKER', names: { 'private:11': 'PRIVATE_ALIAS_MARKER', 'group:1': 'GROUP_ALIAS_OK' }, summaryScope: 'private:11', lastSeenAt: now });
  const groupBrief = storeMod.buildMemoryBrief({ key: 'group:1', actorId: '11', query: '', scopes: ['group:1'] });
  const privateBrief = storeMod.buildMemoryBrief({ key: 'private:11', actorId: '11', query: '', scopes: ['private:11'] });
  assert.equal(groupBrief.includes('PRIVATE_PERSON_MARKER'), false);
  assert.equal(groupBrief.includes('PRIVATE_ALIAS_MARKER'), false);
  assert.equal(groupBrief.includes('GROUP_ALIAS_OK'), true);
  assert.equal(privateBrief.includes('PRIVATE_PERSON_MARKER'), true);
  return { groupBrief, privateBrief };
});

test('unknown-person-summary-is-conservatively-excluded', () => {
  db.prepare(`INSERT INTO people (qq,names_json,summary,last_seen_at,updated_at) VALUES (?,?,?,?,?)`)
    .run('22', JSON.stringify({ unknown: 'UNKNOWN_ALIAS_MARKER' }), 'UNKNOWN_SUMMARY_MARKER', now, now);
  const brief = storeMod.buildMemoryBrief({ key: 'group:1', actorId: '22', query: '', scopes: ['group:1'] });
  assert.equal(brief.includes('UNKNOWN_SUMMARY_MARKER'), false);
  assert.equal(brief.includes('UNKNOWN_ALIAS_MARKER'), false);
  return { brief };
});

test('relationship-summary-requires-explicit-scope', () => {
  db.prepare(`INSERT INTO relationships (subject,object,kind,score,summary,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('33', 'group:1', 'friend', 0.5, 'UNKNOWN_RELATION_MARKER', now);
  db.prepare(`INSERT INTO relationships (subject,object,kind,score,summary,scope,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('44', 'group:1', 'friend', 0.5, 'SHARED_RELATION_MARKER', 'shared', now);
  const unknown = storeMod.buildMemoryBrief({ key: 'group:1', actorId: '33', query: '', scopes: ['group:1'] });
  const shared = storeMod.buildMemoryBrief({ key: 'group:1', actorId: '44', query: '', scopes: ['group:1'] });
  assert.equal(unknown.includes('UNKNOWN_RELATION_MARKER'), false);
  assert.equal(shared.includes('SHARED_RELATION_MARKER'), true);
  return { unknown, shared };
});

test('knowledge-cards-respect-scope', () => {
  knowledgeMod.saveKnowledgeCard({ bvid: 'p1', topic: 'PRIVATE_KNOWLEDGE_TOPIC', title: 'PRIVATE_KNOWLEDGE_MARKER', scope: 'private:11' });
  knowledgeMod.saveKnowledgeCard({ bvid: 'p2', topic: 'SHARED_KNOWLEDGE_TOPIC', title: 'SHARED_KNOWLEDGE_MARKER', scope: 'shared' });
  const groupBrief = knowledgeMod.knowledgeBrief('KNOWLEDGE_TOPIC', 5, { scopes: ['group:1'] });
  const privateBrief = knowledgeMod.knowledgeBrief('KNOWLEDGE_TOPIC', 5, { scopes: ['private:11'] });
  assert.equal(groupBrief.includes('PRIVATE_KNOWLEDGE_MARKER'), false);
  assert.equal(groupBrief.includes('SHARED_KNOWLEDGE_MARKER'), true);
  assert.equal(privateBrief.includes('PRIVATE_KNOWLEDGE_MARKER'), true);
  return { groupBrief, privateBrief };
});

test('platform-items-respect-scope', () => {
  storeMod.addPlatformItem({ platform: 'bili', itemId: 'private-1', title: 'PRIVATE_PLATFORM_MARKER', scope: 'private:11' });
  storeMod.addPlatformItem({ platform: 'bili', itemId: 'shared-1', title: 'SHARED_PLATFORM_MARKER', scope: 'shared' });
  const groupBrief = storeMod.buildMemoryBrief({ key: 'group:1', query: '', scopes: ['group:1'] });
  const privateBrief = storeMod.buildMemoryBrief({ key: 'private:11', query: '', scopes: ['private:11'] });
  assert.equal(groupBrief.includes('PRIVATE_PLATFORM_MARKER'), false);
  assert.equal(groupBrief.includes('SHARED_PLATFORM_MARKER'), true);
  assert.equal(privateBrief.includes('PRIVATE_PLATFORM_MARKER'), true);
  return { groupBrief, privateBrief };
});

test('layered-summaries-require-explicit-scope', () => {
  const fake = path.join(tmp, 'fake-memory');
  for (const rel of ['profile/relationships.json', 'profile/bilibili.json', 'weekly/2026-W45.json', 'monthly/2026-11.json', 'daily/2026-11-05.json', 'daily/2026-11-04.json']) {
    fs.mkdirSync(path.join(fake, path.dirname(rel)), { recursive: true });
  }
  const markerFiles = {
    'profile/relationships.json': { owner: { summary: 'PRIVATE_RELATION_MARKER' } },
    'profile/bilibili.json': { interests: [{ name: 'PRIVATE_PROFILE_MARKER', weight: 1, status: 'active' }] },
    'weekly/2026-W45.json': { summary: 'PRIVATE_WEEKLY_MARKER' },
    'monthly/2026-11.json': { summary: 'PRIVATE_MONTHLY_MARKER' },
    'daily/2026-11-05.json': { summary: 'PRIVATE_DAILY_TODAY_MARKER' },
    'daily/2026-11-04.json': { summary: 'PRIVATE_DAILY_YESTERDAY_MARKER' },
  };
  for (const [rel, data] of Object.entries(markerFiles)) fs.writeFileSync(path.join(fake, rel), JSON.stringify(data));
  const src = fs.readFileSync(path.join(C, 'qq-bridge/src/memory-layers.mjs'), 'utf8');
  const part = src.slice(src.indexOf('const readJson')).replace('export function layeredMemoryBrief', 'function layeredMemoryBrief');
  const reads = [];
  const ctx = vm.createContext({
    path, MEM: fake,
    fs: { readFileSync: (f) => { reads.push(f); return fs.readFileSync(f, 'utf8'); } },
    hybridSearch: () => [],
    knowledgeBrief: () => '',
  });
  vm.runInContext(part, ctx);
  const brief = ctx.layeredMemoryBrief({ scopes: ['group:1'], now: new Date('2026-11-05T00:00:00Z') });
  for (const marker of ['PRIVATE_RELATION_MARKER', 'PRIVATE_PROFILE_MARKER', 'PRIVATE_WEEKLY_MARKER', 'PRIVATE_MONTHLY_MARKER', 'PRIVATE_DAILY_TODAY_MARKER', 'PRIVATE_DAILY_YESTERDAY_MARKER']) {
    assert.equal(brief.includes(marker), false, marker);
  }
  // 显式 shared 旧摘要可以进入 group。
  fs.writeFileSync(path.join(fake, 'weekly/2026-W45.json'), JSON.stringify({ scope: 'shared', summary: 'SHARED_WEEKLY_MARKER' }));
  const sharedBrief = ctx.layeredMemoryBrief({ scopes: ['group:1'], now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(sharedBrief.includes('SHARED_WEEKLY_MARKER'), true);
  return { brief, sharedBrief, reads: reads.length };
});

test('empty-scope-is-not-all', () => {
  const hits = storeMod.hybridSearch('GROUP_ALIAS_OK', 5, { scopes: [] });
  const recents = storeMod.recentEvents({ scopes: [] });
  assert.deepEqual(hits, []);
  assert.deepEqual(recents, []);
  return { hits: hits.length, recents: recents.length };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r1-permissions-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
