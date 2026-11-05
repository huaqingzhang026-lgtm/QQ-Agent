// 回放：评论区额度（顶层按天、回复按小时）。
import assert from 'node:assert/strict';
import { canTopComment, noteTopComment, canReply, noteReply, dayKey } from '../../qq-bridge/src/browse-quota.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const now = new Date(2026, 9, 23, 14, 0, 0).getTime();

check('顶层评论：未到 10 条可发', () => {
  assert.equal(canTopComment({ state: { date: dayKey(now), topComments: 9 }, dailyMax: 10, now }).allow, true);
});

check('顶层评论：到 10 条拒绝', () => {
  assert.equal(canTopComment({ state: { date: dayKey(now), topComments: 10 }, dailyMax: 10, now }).allow, false);
});

check('顶层评论：跨天重置', () => {
  const r = canTopComment({ state: { date: '2000-01-01', topComments: 10 }, dailyMax: 10, now });
  assert.equal(r.allow, true);
  assert.equal(r.used, 0);
});

check('noteTopComment 累加', () => {
  const s = noteTopComment({ date: dayKey(now), topComments: 3 }, now);
  assert.equal(s.topComments, 4);
});

check('回复：1 小时内 19 条可发', () => {
  const replies = Array.from({ length: 19 }, (_, i) => now - (i + 1) * 60000);
  assert.equal(canReply({ state: { replies, lastCommentAt: now - 600000 }, perHour: 20, minGapMs: 120000, now }).allow, true);
});

check('回复：1 小时内 20 条拒绝', () => {
  const replies = Array.from({ length: 20 }, (_, i) => now - (i + 1) * 60000);
  assert.equal(canReply({ state: { replies, lastCommentAt: now - 600000 }, perHour: 20, minGapMs: 120000, now }).allow, false);
});

check('回复：超过 1 小时的旧记录不计', () => {
  const replies = Array.from({ length: 20 }, (_, i) => now - 3600000 - (i + 1) * 60000);
  assert.equal(canReply({ state: { replies, lastCommentAt: now - 600000 }, perHour: 20, minGapMs: 120000, now }).allow, true);
});

check('回复：最小间隔', () => {
  const r = canReply({ state: { replies: [], lastCommentAt: now - 30000 }, perHour: 20, minGapMs: 120000, now });
  assert.equal(r.allow, false);
  assert.equal(r.gapOk, false);
});

check('noteReply 记录并裁剪', () => {
  const s = noteReply({ replies: [now - 7200000] }, now);
  assert.equal(s.replies.length, 1);
  assert.equal(s.lastCommentAt, now);
});

console.log(`browse-quota replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
