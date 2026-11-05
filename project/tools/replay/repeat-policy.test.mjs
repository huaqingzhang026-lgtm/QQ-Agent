// 回放：复读内容去重（repeat-policy）。

import assert from 'node:assert/strict';
import { decideRepeat, pushRepeatHistory, normalizeRepeatText, DEFAULT_WINDOW_MS } from '../../qq-bridge/src/repeat-policy.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const now = 10_000_000;
const base = { text: '哈哈哈哈', count: 3, now };

check('达到 3 条且无历史 → 复读', () => {
  assert.equal(decideRepeat(base).repeat, true);
});

check('不足 3 条 → 不复读', () => {
  assert.equal(decideRepeat({ ...base, count: 2 }).reason, 'not-enough');
});

check('历史里有过同一句 → 不复读', () => {
  const history = [{ t: '哈哈哈哈', at: now - 1000 }];
  const r = decideRepeat({ ...base, history });
  assert.equal(r.repeat, false);
  assert.equal(r.reason, 'already-repeated');
});

check('历史超过窗口 → 可以再复读', () => {
  const history = [{ t: '哈哈哈哈', at: now - DEFAULT_WINDOW_MS - 1 }];
  assert.equal(decideRepeat({ ...base, history }).repeat, true);
});

check('自己最近说过同一句 → 不复读', () => {
  const recentMessages = [{ text: '哈哈哈哈', isSelf: true, time: now - 5000 }];
  const r = decideRepeat({ ...base, recentMessages });
  assert.equal(r.repeat, false);
  assert.equal(r.reason, 'self-said-recently');
});

check('别人说过同一句不算（只看自己）', () => {
  const recentMessages = [{ text: '哈哈哈哈', isSelf: false, time: now - 5000 }];
  assert.equal(decideRepeat({ ...base, recentMessages }).repeat, true);
});

check('空白差异视为同一句', () => {
  const history = [{ t: '哈哈  哈哈', at: now - 1000 }];
  assert.equal(decideRepeat({ ...base, text: '哈哈 哈哈', history }).repeat, false);
});

check('图片占位符不复读', () => {
  assert.equal(decideRepeat({ ...base, text: '[图片]', count: 5 }).reason, 'media-placeholder');
});

check('命令不复读', () => {
  assert.equal(decideRepeat({ ...base, text: '/reset', count: 5 }).reason, 'command');
  assert.equal(decideRepeat({ ...base, text: '@某人 你好', count: 5 }).reason, 'command');
});

check('过长文本不复读', () => {
  assert.equal(decideRepeat({ ...base, text: 'x'.repeat(41), count: 5 }).reason, 'length');
});

check('空文本不复读', () => {
  assert.equal(decideRepeat({ ...base, text: '   ', count: 5 }).reason, 'empty');
});

check('历史记录去重并保留最新', () => {
  let h = [];
  h = pushRepeatHistory(h, 'A', 1);
  h = pushRepeatHistory(h, 'B', 2);
  h = pushRepeatHistory(h, 'A', 3);
  assert.equal(h.length, 2);
  assert.equal(h.at(-1).t, 'A');
  assert.equal(h.at(-1).at, 3);
});

check('历史裁剪到上限', () => {
  let h = [];
  for (let i = 0; i < 80; i++) h = pushRepeatHistory(h, `x${i}`, i);
  assert.equal(h.length, 50);
});

check('归一化压缩空白', () => {
  assert.equal(normalizeRepeatText('  a   b  '), 'a b');
});

console.log(`repeat-policy replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
