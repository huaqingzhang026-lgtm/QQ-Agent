// 回放：验收门禁（F09）。注入式验证不同组合的退出码，不依赖真实服务。

import assert from 'node:assert/strict';
import { computeFailureList, exitCodeFor } from '../../tools/lib/acceptance-gate.mjs';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const ok = (label) => ({ label, ok: true, detail: '' });
const bad = (label, detail = 'x') => ({ label, ok: false, detail });

check('全绿 → 无失败、退出 0', () => {
  const r = [ok('a'), ok('readiness')];
  assert.deepEqual(computeFailureList(r), []);
  assert.equal(exitCodeFor(r), 0);
});

check('普通检查失败 → 退出 1', () => {
  const r = [ok('a'), bad('b'), ok('readiness')];
  assert.equal(computeFailureList(r).length, 1);
  assert.equal(exitCodeFor(r), 1);
});

check('readiness 失败 → 默认退出 1', () => {
  const r = [ok('a'), bad('readiness', 'QQ 未登录')];
  assert.equal(computeFailureList(r).length, 1);
  assert.equal(exitCodeFor(r), 1);
});

check('readiness 失败 + --allow-degraded → 退出 0', () => {
  const r = [ok('a'), bad('readiness', 'QQ 未登录')];
  assert.equal(computeFailureList(r, { allowDegraded: true }).length, 0);
  assert.equal(exitCodeFor(r, { allowDegraded: true }), 0);
});

check('--allow-degraded 不放行普通失败', () => {
  const r = [bad('a'), bad('readiness')];
  assert.equal(computeFailureList(r, { allowDegraded: true }).length, 1);
  assert.equal(exitCodeFor(r, { allowDegraded: true }), 1);
});

check('readiness 探测超时/坏 JSON（ok=false 无 detail）也算失败', () => {
  const r = [{ label: 'readiness', ok: false }];
  assert.equal(computeFailureList(r).length, 1);
});

check('空结果 → 视为无失败（调用方自行兜底）', () => {
  assert.deepEqual(computeFailureList([]), []);
  assert.deepEqual(computeFailureList(undefined), []);
});

console.log(`acceptance-gate replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
