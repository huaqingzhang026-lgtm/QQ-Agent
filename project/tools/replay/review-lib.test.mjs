// 回放：夜间复盘的时间窗/取样/通知判定。
import assert from 'node:assert/strict';
import { reviewWindow, collectSelfMessages, decideNotify, summarizeIssues, dayKey } from '../../qq-bridge/src/review-lib.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const now = new Date(2026, 9, 23, 0, 5, 0).getTime();
const w = reviewWindow(now);

check('00:05 复盘的是昨天', () => {
  assert.equal(w.date, '2026-10-22');
  assert.equal(new Date(w.start).getDate(), 22);
  assert.equal(new Date(w.end).getDate(), 23);
});

check('只取她自己、窗口内的消息', () => {
  const conversations = {
    'group:1': { recentMessages: [
      { isSelf: true, text: '昨天的自己', time: w.start + 1000 },
      { isSelf: false, text: '别人', time: w.start + 2000 },
      { isSelf: true, text: '今天的自己', time: w.end + 1000 },
      { isSelf: true, text: '', time: w.start + 3000 },
    ] },
  };
  const out = collectSelfMessages(conversations, { start: w.start, end: w.end });
  assert.deepEqual(out.map((x) => x.text), ['昨天的自己']);
});

check('按时间排序', () => {
  const conversations = {
    'a': { recentMessages: [{ isSelf: true, text: 'B', time: w.start + 2000 }] },
    'b': { recentMessages: [{ isSelf: true, text: 'A', time: w.start + 1000 }] },
  };
  const out = collectSelfMessages(conversations, { start: w.start, end: w.end });
  assert.deepEqual(out.map((x) => x.text), ['A', 'B']);
});

check('max 截断', () => {
  const conversations = { 'g': { recentMessages: Array.from({ length: 5 }, (_, i) => ({ isSelf: true, text: `m${i}`, time: w.start + i })) } };
  assert.equal(collectSelfMessages(conversations, { start: w.start, end: w.end, max: 2 }).length, 2);
});

check('高危/不可自修 → 通知', () => {
  assert.equal(decideNotify([{ severity: 'low', fixable: true }]), false);
  assert.equal(decideNotify([{ severity: 'high', fixable: true }]), true);
  assert.equal(decideNotify([{ severity: 'low', fixable: false }]), true);
  assert.equal(decideNotify([]), false);
});

check('统计', () => {
  const s = summarizeIssues([{ severity: 'high', fixable: true }, { severity: 'low', fixable: false }, { severity: 'low', fixable: true }]);
  assert.deepEqual(s, { total: 3, high: 1, fixable: 2, unfixable: 1 });
});

check('dayKey 本地日期', () => {
  assert.equal(dayKey(new Date(2026, 9, 23, 23, 59).getTime()), '2026-10-23');
});

console.log(`review-lib replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
