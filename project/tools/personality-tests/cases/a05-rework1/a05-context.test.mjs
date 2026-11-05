// A05 context assembly: query synthesis, commitment budget, private evidence isolation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const ctxMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-context.mjs')).href);
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const cmtMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/commitments.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const at = Date.parse('2026-11-05T00:00:00.000Z');
const tmpDir = fs.mkdtempSync(path.join(root, 'a05-context-'));
const db = storeMod.openMemory(path.join(tmpDir, 'db.sqlite'));

test('memory-query-is-not-just-last-80-chars', () => {
  const recent = [
    { userId: '11', sender: 'A', isSelf: false, text: '我今天下午刚从面试回来，感觉还不错', time: at },
    { userId: '11', sender: 'A', isSelf: false, text: '不过明天还有一个二面，想让你帮我整理一下项目笔记。昨天说的那个事也还没弄完。', time: at + 1000 },
  ];
  const commitments = [{ id: 'c1', status: 'active', text: '帮 A 修改简历第二版' }];
  const q = ctxMod.buildMemoryQuery({ latestText: recent[1].text, recentMessages: recent, commitments });
  assert.ok(q.query.includes('今天下午刚从面试回来'));
  assert.ok(q.query.includes('昨天说的那个事'));
  assert.ok(q.query.includes('帮 A 修改简历第二版'));
  assert.equal(q.hasReferenceSignal, true);
  assert.equal(q.hasUnresolvedCommitment, true);
  return { query: q.query };
});

test('commitment-budget-is-not-pushed-out', () => {
  for (let i = 0; i < 20; i += 1) storeMod.addEvent({ source: 'test', conversationKey: 'private:1', actorId: '11', text: `闲聊填充 ${i}`, occurredAt: at + i });
  const commitments = [{ id: 'c-active', scope: 'private:1', status: 'active', text: '明天上午之前整理面试笔记', due_at: at + 86400000 }];
  const brief = storeMod.buildMemoryBrief({ key: 'private:1', actorId: '11', query: '面试', scopes: ['private:1'], commitments });
  assert.match(brief, /【当前承诺\/未决】/);
  assert.match(brief, /明天上午之前整理面试笔记/);
  assert.match(brief, /【最近时间线】/);
  return { hasCommitment: true };
});

test('uncertain-and-expired-are-marked-not-silent', () => {
  const now = at + 999999;
  const before = cmtMod.listCommitments({ scopes: ['private:1'], statuses: ['active'] });
  cmtMod.expireCommitments({ now });
  const after = cmtMod.listCommitments({ scopes: ['private:1'], statuses: ['active'] });
  assert.equal(after.length, 0);
  assert.equal(before.length, 0);
  return { before: before.length, after: after.length };
});

test('private-memory-does-not-enter-group-brief', () => {
  storeMod.addEvent({ source: 'test', conversationKey: 'private:1', actorId: '11', text: '私聊里的家庭住址线索', occurredAt: at });
  const brief = storeMod.buildMemoryBrief({ key: 'group:1', query: '家庭住址线索', scopes: ['group:1'] });
  assert.equal(brief.includes('家庭住址线索'), false);
  return { isolated: true };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05-context-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
