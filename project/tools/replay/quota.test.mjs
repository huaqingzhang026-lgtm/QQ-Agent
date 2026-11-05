// 回放：群聊发言额度与"借口离开"。

import assert from 'node:assert/strict';
import { quotaState, capForConversation, minuteCapForConversation, shouldExcuse, pickLeaveLine, inDive, DEFAULT_LEAVE_LINES } from '../../qq-bridge/src/quota.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const now = 10_000_000;
const at = (n, gap = 60000) => Array.from({ length: n }, (_, i) => now - (i + 1) * gap);

check('未发言时额度满额', () => {
  const q = quotaState({ cap: 10, sendTimes: [], now });
  assert.equal(q.used, 0);
  assert.equal(q.remain, 10);
  assert.equal(q.full, false);
});

check('用了 3 条剩 7', () => {
  const q = quotaState({ cap: 10, sendTimes: at(3), now });
  assert.equal(q.used, 3);
  assert.equal(q.remain, 7);
});

check('用满 10 条进入 full', () => {
  const q = quotaState({ cap: 10, sendTimes: at(10), now });
  assert.equal(q.full, true);
  assert.equal(q.remain, 0);
});

check('超过 1 小时的发言不计入', () => {
  const old = [now - 3700000, now - 3600001];
  const q = quotaState({ cap: 10, sendTimes: [...old, ...at(2)], now });
  assert.equal(q.used, 2);
});

check('freeAt 是窗口内最早一条 + 1 小时', () => {
  const times = [now - 100000, now - 3000000];
  const q = quotaState({ cap: 10, sendTimes: times, now });
  assert.equal(q.freeAt, now - 3000000 + 3600000);
});

check('cap=0 视为不限（full=false）', () => {
  const q = quotaState({ cap: 0, sendTimes: at(50), now });
  assert.equal(q.full, false);
});

check('会话覆盖优先于全局', () => {
  const cfg = { maxSendPerHour: 300, conversationOverrides: { 'group:1': { maxSendPerHour: 10 } } };
  assert.equal(capForConversation('group:1', cfg), 10);
  assert.equal(capForConversation('group:2', cfg), 300);
});

check('额度满 + 被 @ + 未道别 → 该借口', () => {
  const q = quotaState({ cap: 10, sendTimes: at(10), now });
  assert.equal(shouldExcuse({ quota: q, atMe: true, excuseAt: 0, now }), true);
});

check('额度满但不是 @ → 不借口（潜水）', () => {
  const q = quotaState({ cap: 10, sendTimes: at(10), now });
  assert.equal(shouldExcuse({ quota: q, atMe: false, excuseAt: 0, now }), false);
});

check('这一小时已道别过 → 不再重复', () => {
  const q = quotaState({ cap: 10, sendTimes: at(10), now });
  assert.equal(shouldExcuse({ quota: q, atMe: true, excuseAt: now - 60000, now }), false);
});

check('道别超过一小时可再次道别（新窗口）', () => {
  const q = quotaState({ cap: 10, sendTimes: at(10), now });
  assert.equal(shouldExcuse({ quota: q, atMe: true, excuseAt: now - 3600001, now }), true);
});

check('额度没满 → 不借口', () => {
  const q = quotaState({ cap: 10, sendTimes: at(2), now });
  assert.equal(shouldExcuse({ quota: q, atMe: true, at: 0, now }), false);
});

check('借口选句：默认列表', () => {
  assert.ok(DEFAULT_LEAVE_LINES.includes(pickLeaveLine({}, () => 0)));
  assert.ok(DEFAULT_LEAVE_LINES.includes(pickLeaveLine({}, () => 0.99)));
});

check('借口选句：自定义列表', () => {
  assert.equal(pickLeaveLine({ lines: ['去洗澡'] }, () => 0), '去洗澡');
});

check('借口选句：随机值越界不崩', () => {
  assert.ok(pickLeaveLine({ lines: ['a', 'b'] }, () => 1) === 'b');
  assert.ok(pickLeaveLine({ lines: ['a', 'b'] }, () => -1) === 'a');
});

check('潜水判定', () => {
  assert.equal(inDive({ diveUntil: now + 1000, now }), true);
  assert.equal(inDive({ diveUntil: now - 1, now }), false);
  assert.equal(inDive({ diveUntil: 0, now }), false);
});

check('分钟上限：2 条/分钟', () => {
  const now = Date.now();
  const q = quotaState({ cap: 20, maxPerMinute: 2, sendTimes: [now - 3000, now - 2000], now });
  assert.equal(q.minuteFull, true);
  assert.equal(q.full, false);
});

check('分钟上限未到', () => {
  const now = Date.now();
  const q = quotaState({ cap: 20, maxPerMinute: 2, sendTimes: [now - 3000], now });
  assert.equal(q.minuteFull, false);
});

check('分钟上限按会话覆盖', () => {
  const cfg = { send: { maxSendPerMinute: 2, conversationOverrides: { 'group:1': { maxSendPerMinute: 1 } } } };
  assert.equal(minuteCapForConversation('group:1', cfg.send), 1);
  assert.equal(minuteCapForConversation('group:2', cfg.send), 2);
});

console.log(`quota replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
