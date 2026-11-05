// A05-rework1 F05：相关命中不被无关时间线挤掉；查询合成行为级验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const contextMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-context.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, 'a05r1-relevance-'));
const db = storeMod.openMemory(path.join(tmp, 'memory.sqlite'));
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const now = Date.now();
const old = now - 60 * 86400000;

test('exact-old-hit-survives-unrelated-recent-noise', () => {
  storeMod.addEvent({ source: 'test', conversationKey: 'group:77', actorId: '11', actorName: 'A', text: 'UNIQUE_INTERVIEW_REFERENCE', occurredAt: old });
  for (let i = 0; i < 40; i += 1) {
    storeMod.addEvent({ source: 'test', conversationKey: 'group:77', actorId: '11', actorName: 'A', text: `unrelated weather ${i}`, occurredAt: now - i });
  }
  const hits = storeMod.hybridSearch('UNIQUE_INTERVIEW_REFERENCE', 4, { scopes: ['group:77'] });
  assert.ok(hits.some((x) => x.text === 'UNIQUE_INTERVIEW_REFERENCE'));
  assert.equal(hits[0].text, 'UNIQUE_INTERVIEW_REFERENCE');
  assert.ok(hits[0].matchedBy.includes('fts'));
  return { hits: hits.map((x) => ({ text: x.text, score: x.score, matchedBy: x.matchedBy, sourcePriority: x.sourcePriority })) };
});

test('tomorrow-reference-recalls-interview-context', () => {
  storeMod.addEvent({ source: 'test', conversationKey: 'private:11', actorId: '11', actorName: 'A', text: '我今天参加了产品经理面试，聊到了项目复盘', occurredAt: old + 1 });
  const recent = [
    { userId: '11', isSelf: false, text: '我今天参加了产品经理面试，聊到了项目复盘', time: old + 1 },
    { userId: '11', isSelf: false, text: '明天那个事还要准备一下。', time: now - 1000 },
  ];
  const q = contextMod.buildMemoryQuery({ latestText: recent[1].text, recentMessages: recent, commitments: [] });
  const hits = storeMod.hybridSearch(q.query, 4, { scopes: ['private:11'] });
  assert.equal(q.hasReferenceSignal, true);
  assert.ok(hits.some((x) => x.text.includes('产品经理面试')));
  const brief = storeMod.buildMemoryBrief({ key: 'private:11', query: q.query, scopes: ['private:11'] });
  assert.match(brief, /产品经理面试/);
  return { query: q.query, hits: hits.map((x) => x.text), brief: brief.slice(0, 240) };
});

test('missing-clues-stay-uncertain-and-ask-one-clarify', () => {
  const q = contextMod.buildMemoryQuery({ latestText: '那个事怎么样了？', recentMessages: [], commitments: [] });
  assert.equal(q.hasReferenceSignal, true);
  assert.equal(q.hasUnresolvedCommitment, false);
  const brief = storeMod.buildMemoryBrief({ key: 'group:1', query: q.query, scopes: ['group:1'] });
  assert.equal(brief.includes('面试'), false);
  return { query: q.query, brief };
});

test('new-interest-fact-overrides-old-interest', () => {
  const scope = 'group:88';
  storeMod.addEvent({ source: 'test', conversationKey: scope, actorId: '11', text: '以前最喜欢玩旧游戏 A', occurredAt: old + 2 });
  storeMod.addEvent({ source: 'test', conversationKey: scope, actorId: '11', text: '现在更喜欢新游戏 B，最近一直在玩', occurredAt: now - 500 });
  const hits = storeMod.hybridSearch('现在更喜欢哪类游戏', 4, { scopes: [scope] });
  assert.ok(hits.some((x) => x.text.includes('新游戏 B')));
  const brief = storeMod.buildMemoryBrief({ key: scope, query: '现在更喜欢哪类游戏', scopes: [scope] });
  assert.match(brief, /新游戏 B/);
  return { hits: hits.map((x) => x.text), brief: brief.slice(0, 240) };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r1-relevance-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
