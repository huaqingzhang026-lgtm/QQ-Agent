// 回放：模型路由链与降级判定。
import assert from 'node:assert/strict';
import { chainForKey, nextModel, normalizeRouting, isInternalKey } from '../../qq-bridge/src/model-router.js';

let pass = 0;
const fails = [];
const check = (n, f) => { try { f(); pass++; } catch (e) { fails.push(`${n}: ${e.message}`); } };

const cfg = { socialV2: { modelRouting: { chain: [
  { provider: 'jojo', model: 'gpt-6-astra' },
  { provider: 'jojo', model: 'gpt-6.1-sol' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
] } } };

check('默认链顺序', () => {
  const c = chainForKey('group:1', cfg);
  assert.deepEqual(c.map((x) => x.model), ['gpt-6-astra', 'gpt-6.1-sol', 'deepseek-flash']);
});

check('内部会话只用 deepseek', () => {
  assert.equal(isInternalKey('internal:黑话学习'), true);
  assert.equal(isInternalKey('heartbeat'), true);
  assert.deepEqual(chainForKey('internal:x', cfg).map((x) => x.model), ['deepseek-flash']);
});

check('nextModel 到末端为 null', () => {
  const c = chainForKey('group:1', cfg);
  assert.equal(nextModel(c, 0).model, 'gpt-6.1-sol');
  assert.equal(nextModel(c, 2), null);
});

check('10s 默认超时', () => {
  assert.equal(normalizeRouting(cfg).firstOutputTimeoutMs, 10000);
});

check('停用返回空链', () => {
  assert.deepEqual(chainForKey('group:1', { socialV2: { modelRouting: { enabled: false } } }), []);
});

console.log(`model-router replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { fails.forEach((f) => console.log('  ✗', f)); process.exit(1); }
