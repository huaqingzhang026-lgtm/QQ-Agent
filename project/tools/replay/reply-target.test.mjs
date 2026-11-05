// 回放：引用目标解析（本地 seq ↔ QQ messageId 两个 id 空间）。
//
// 背景：群里 @ 她时出现「引用串到别的消息」，根因是旧实现把「按 seq 找不到」
// 直接降级成「把这个数字当 message_id 去 get_msg」。seq 是会话内自增的小整数，
// 且 recentMessages 只保留最近 N 条 —— 一个被裁掉的旧 seq 会被当成某个真实
// messageId 去查，静默命中同群另一条消息。
//
// 运行：node tools/replay/reply-target.test.mjs

import assert from 'node:assert/strict';
import { resolveReplyRef, replyRefErrorText, REPLY_REF } from '../../qq-bridge/src/reply-target.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

// 会话内的三条消息：seq 11/12/13，真实 messageId 是大整数（含一个负数）。
const recentMessages = [
  { seq: 11, messageId: '7300000000000000001', sender: '甲', text: '在吗' },
  { seq: 12, messageId: '7300000000000000002', sender: '乙', text: '今晚打不打' },
  { seq: 13, messageId: '-914000000000000003', sender: '丙', text: '引用我这条' }
];
const lastUnreadSeq = 13;

check('命中 seq → 映射成真实 messageId', () => {
  const r = resolveReplyRef({ ref: '12', recentMessages, lastUnreadSeq });
  assert.equal(r.ok, true);
  assert.equal(r.kind, REPLY_REF.SEQ);
  assert.equal(r.messageId, '7300000000000000002');
  assert.equal(r.message.text, '今晚打不打');
});

check('命中 messageId → 原样使用（负数也认）', () => {
  const r = resolveReplyRef({ ref: '-914000000000000003', recentMessages, lastUnreadSeq });
  assert.equal(r.ok, true);
  assert.equal(r.kind, REPLY_REF.MESSAGE_ID);
  assert.equal(r.messageId, '-914000000000000003');
});

check('过期的 seq 不再冒充 messageId（旧实现会静默引错）', () => {
  // seq=7 早已被 recentMessages 裁掉，但仍在 [1, lastUnreadSeq] 区间内。
  const r = resolveReplyRef({ ref: '7', recentMessages, lastUnreadSeq });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale-seq');
  assert.match(replyRefErrorText(r), /seq=7/);
});

check('本地 seq 没有真实 messageId → 拒绝，不猜', () => {
  const list = [{ seq: 21, messageId: null, sender: '甲', text: '合成消息' }];
  const r = resolveReplyRef({ ref: '21', recentMessages: list, lastUnreadSeq: 21 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'seq-without-message-id');
});

check('同一串数字既是 messageId 又是另一条的 seq → 判歧义', () => {
  // 111 是甲的 messageId，同时又是丙的 seq（两条不同的消息）。
  const conflict = [
    { seq: 30, messageId: '111', sender: '甲', text: 'A' },
    { seq: 40, messageId: '222', sender: '乙', text: 'B' },
    { seq: 111, messageId: '333', sender: '丙', text: 'C' }
  ];
  const r = resolveReplyRef({ ref: '111', recentMessages: conflict, lastUnreadSeq: 111 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
});

check('不在 seq 区间内、也查不到本地的 id → 交给 OneBot 校验', () => {
  const r = resolveReplyRef({ ref: '7300000000000000999', recentMessages, lastUnreadSeq });
  assert.equal(r.ok, true);
  assert.equal(r.kind, REPLY_REF.MESSAGE_ID);
  assert.equal(r.message, null);
});

check('空值与非整数直接拒绝', () => {
  assert.equal(resolveReplyRef({ ref: '  ', recentMessages }).ok, false);
  assert.equal(resolveReplyRef({ ref: '12.5', recentMessages }).reason, 'not-integer');
  assert.equal(resolveReplyRef({ ref: 'abc', recentMessages }).reason, 'not-integer');
});

check('状态里缺 recentMessages / lastUnreadSeq 时不抛异常', () => {
  const r = resolveReplyRef({ ref: '5' });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, '5');
});

console.log(`reply-target replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
