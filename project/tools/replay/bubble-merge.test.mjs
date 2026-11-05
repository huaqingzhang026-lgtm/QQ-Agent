// 回放：额度不足时的气泡合并不得凭空补标点。
//
// 旧实现：`messages.slice(i, i + per).join('，')` —— 「我不饿」+「你先吃」
// 会变成「我不饿，你先吃」，那个逗号是桥接发明的，不是她写的。
// 新规则：已有分隔（空白/标点）就沿用，没有就用换行，绝不新增标点。
//
// 运行：node tools/replay/bubble-merge.test.mjs

import assert from 'node:assert/strict';
import { mergeBubblesForQuota, joinBubbles } from '../../qq-bridge/src/md-to-plain.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };
const PUNCT = /[。！？!?…，,、；;：:]/;

check('额度够时不合并、原样返回', () => {
  const input = ['我不饿', '你先吃'];
  assert.deepEqual(mergeBubblesForQuota(input, 2), input);
});

check('合并不新增任何标点', () => {
  const out = mergeBubblesForQuota(['我不饿', '你先吃', '别等我'], 1);
  assert.equal(out.length, 1);
  const joined = out[0];
  for (const ch of joined) {
    if (PUNCT.test(ch)) assert.fail(`合并结果里出现了原文没有的标点：${ch} → ${joined}`);
  }
  assert.equal(joined.replace(/\n/g, ''), '我不饿你先吃别等我');
});

check('原文末尾已有标点 → 直接拼，不重复加分隔符', () => {
  assert.equal(joinBubbles(['我先睡了。', '你也早点睡']), '我先睡了。你也早点睡');
  assert.equal(joinBubbles(['等我一下，', '马上来']), '等我一下，马上来');
});

check('原文带空白 → 沿用空白，不额外插入', () => {
  assert.equal(joinBubbles(['hello ', 'world']), 'hello world');
  assert.equal(joinBubbles(['hello', ' world']), 'hello world');
});

check('两条都不带分隔 → 用换行，不用逗号', () => {
  const s = joinBubbles(['在吗', '在吗在吗']);
  assert.equal(s, '在吗\n在吗在吗');
  assert.ok(!PUNCT.test(s));
});

check('3 条合并成 1 条时内容一字不丢', () => {
  const parts = ['今天好热', '空调又坏了', '修的人明天才来'];
  const out = mergeBubblesForQuota(parts, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].replace(/\n/g, ''), parts.join(''));
});

check('3 条合并成 2 条：分组正确且总内容不变', () => {
  const parts = ['一', '二', '三'];
  const out = mergeBubblesForQuota(parts, 2);
  assert.equal(out.length, 2);
  assert.equal(out.join('').replace(/\n/g, ''), '一二三');
});

check('room 为 0/负数/非数字时按 1 条处理，不会死循环', () => {
  for (const room of [0, -3, 'x', null, undefined]) {
    const out = mergeBubblesForQuota(['甲', '乙'], room);
    assert.equal(out.length, 1);
  }
});

check('空数组与空串不产生空气泡', () => {
  assert.deepEqual(mergeBubblesForQuota([], 1), []);
  assert.deepEqual(mergeBubblesForQuota(['', '  '], 1), []);
  assert.equal(joinBubbles([]), '');
});

console.log(`bubble-merge replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
