// 回放：每日预算降级（¥70 去 Astra，¥100 只留 DeepSeek）。
import assert from 'node:assert/strict';
import { applyBudget, chainForKey, budgetConfig, spendOfRows } from '../../qq-bridge/src/model-router.js';

let pass = 0;
const fails = [];
const check = (n, f) => { try { f(); pass++; } catch (e) { fails.push(`${n}: ${e.message}`); } };

const cfg = { socialV2: { modelRouting: {
  chain: [
    { provider: 'jojo', model: 'gpt-6-astra' },
    { provider: 'jojo', model: 'gpt-6.1-sol' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ],
  dailyBudget: { limitYuan: 100, downgradeAtYuan: 70 },
} } };

const chain = chainForKey('group:1', cfg);
const models = (s) => applyBudget(chain, s, cfg).map((x) => x.model);

check('0 元保留 Astra', () => assert.deepEqual(models(0), ['gpt-6-astra', 'gpt-6.1-sol', 'deepseek-flash']));
check('69.9 元保留 Astra', () => assert.deepEqual(models(69.9), ['gpt-6-astra', 'gpt-6.1-sol', 'deepseek-flash']));
check('70 元切到 Sol', () => assert.deepEqual(models(70), ['gpt-6.1-sol', 'deepseek-flash']));
check('99.9 元仍是 Sol', () => assert.deepEqual(models(99.9), ['gpt-6.1-sol', 'deepseek-flash']));
check('100 元只留 DeepSeek', () => assert.deepEqual(models(100), ['deepseek-flash']));

check('按 turn 行计价', () => {
  const day = new Date(2026, 9, 24).getTime();
  const rows = [
    { k: 'turn', t: day + 1, provider: 'jojo', model: 'gpt-6-astra', b: { cacheMiss: 1e6, cacheHit: 0, output: 0 } },
    { k: 'base', t: day + 2, provider: 'jojo', model: 'gpt-6-astra', b: { cacheMiss: 9e6, output: 0 } },
    { k: 'turn', t: day + 3, provider: 'deepseek-account', model: 'deepseek-flash', b: { cacheMiss: 9e6 } },
  ];
  assert.equal(Number(spendOfRows(rows, day).toFixed(2)), 1.7);
});

check('预算配置默认值', () => {
  const b = budgetConfig({});
  assert.equal(b.limitYuan, 100);
  assert.equal(b.downgradeAtYuan, 70);
});

console.log(`budget replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { fails.forEach((f) => console.log('  ✗', f)); process.exit(1); }
