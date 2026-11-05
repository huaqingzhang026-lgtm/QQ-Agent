// 回放：QQ 空间自动说说决策与状态。
import assert from 'node:assert/strict';
import { decideQzonePost, noteQzonePost, normalizeQzoneConfig, dayKey } from '../../qq-bridge/src/qzone-auto.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const cfg = { socialV2: { qzone: { enabled: true, probability: 0.35, intervalMs: 90 * 60 * 1000, dailyMax: 2, imageProbability: 0.85, ugcRight: 4, activeStart: 9, activeEnd: 24 } } };
const at = (h, m = 0) => new Date(2026, 9, 23, h, m, 0).getTime();

check('配置合并默认值', () => {
  const c = normalizeQzoneConfig({ socialV2: { qzone: { dailyMax: 3 } } });
  assert.equal(c.dailyMax, 3);
  assert.equal(c.probability, 0.35);
});

check('白天命中 → 发', () => {
  const d = decideQzonePost({ state: {}, cfg, now: at(14), random: () => 0.1 });
  assert.equal(d.post, true);
  assert.equal(d.reason, 'hit');
});

check('概率未命中 → 不发', () => {
  const d = decideQzonePost({ state: {}, cfg, now: at(14), random: () => 0.9 });
  assert.equal(d.post, false);
  assert.equal(d.reason, 'miss');
});

check('夜间不发', () => {
  const d = decideQzonePost({ state: {}, cfg, now: at(3), random: () => 0.1 });
  assert.equal(d.post, false);
  assert.equal(d.reason, 'inactive-hours');
});

check('每天上限', () => {
  const d = decideQzonePost({ state: { date: dayKey(at(14)), count: 2, lastAt: 0 }, cfg, now: at(14), random: () => 0.1 });
  assert.equal(d.post, false);
  assert.equal(d.reason, 'daily-max');
});

check('最小间隔', () => {
  const now = at(14);
  const d = decideQzonePost({ state: { date: dayKey(now), count: 1, lastAt: now - 30 * 60 * 1000 }, cfg, now, random: () => 0.1 });
  assert.equal(d.post, false);
  assert.equal(d.reason, 'interval');
});

check('跨天计数清零', () => {
  const now = at(14);
  const d = decideQzonePost({ state: { date: '2000-01-01', count: 9, lastAt: 0 }, cfg, now, random: () => 0.1 });
  assert.equal(d.post, true);
  assert.equal(d.count, 0);
});

check('noteQzonePost 累加与重置', () => {
  const now = at(14);
  const s1 = noteQzonePost({ date: dayKey(now), count: 1, lastAt: 0 }, now);
  assert.equal(s1.count, 2);
  const s2 = noteQzonePost({ date: '2000-01-01', count: 5 }, now);
  assert.equal(s2.count, 1);
});

check('停用', () => {
  const d = decideQzonePost({ state: {}, cfg: { socialV2: { qzone: { enabled: false } } }, now: at(14), random: () => 0.1 });
  assert.equal(d.reason, 'disabled');
});

console.log(`qzone-auto replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
