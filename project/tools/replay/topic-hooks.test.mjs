// 回放：话题钩子的解析与启发式兜底。
import assert from 'node:assert/strict';
import { heuristicHooks, parseHooks } from '../../qq-bridge/src/topic-hooks.js';

let pass = 0;
const fails = [];
const check = (n, f) => { try { f(); pass++; } catch (e) { fails.push(`${n}: ${e.message}`); } };

check('解析 JSON 数组', () => {
  const h = parseHooks('["问A游戏过了没","接B的猫"]');
  assert.deepEqual(h, ['问A游戏过了没', '接B的猫']);
});

check('解析行列表', () => {
  const h = parseHooks('- 问A游戏\n- 接B的猫');
  assert.deepEqual(h.slice(0, 2), ['问A游戏', '接B的猫']);
});

check('启发式优先问题', () => {
  const h = heuristicHooks([
    { isSelf: false, sender: 'A', text: '你那个游戏过了吗？' },
    { isSelf: false, sender: 'B', text: '我今天买了只猫' },
  ], 2);
  assert.match(h[0], /A/);
  assert.match(h[0], /游戏/);
});

check('启发式跳过自己', () => {
  const h = heuristicHooks([{ isSelf: true, sender: '我', text: '你们最近看什么？' }], 2);
  assert.equal(h.length, 0);
});

console.log(`topic-hooks replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { fails.forEach((f) => console.log('  ✗', f)); process.exit(1); }
