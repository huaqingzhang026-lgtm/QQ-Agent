// 回放：设置潜水不得覆盖已排好的定时唤醒。
//
// 旧实现在 /api/socialV2/wake-config 里有一行 `if (next.infinite) next.sleepUntil = null`，
// 而 infinite 是从**当前配置**继承来的。于是「当前是无限期潜水」时，即使这次明确传了
// sleepMs / sleepUntil（约一个定时唤醒），算出来的时间点也会被无条件清掉，
// 接口还返回 ok:true —— 定时唤醒被潜水设置静默覆盖。
//
// 运行：node tools/replay/wake-timing.test.mjs

import assert from 'node:assert/strict';
import { resolveWakeTiming, parseSleepUntil } from '../../qq-bridge/src/wake-timing.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const NOW = new Date('2026-10-27T22:38:00+08:00').getTime();
const iso = (ms) => new Date(ms).toISOString();
const limits = { sleepMinMs: 60000, sleepMaxMs: 8 * 3600 * 1000, recommendedSleepMinMs: 300000, recommendedSleepMaxMs: 7200000 };
const fixedRandom = () => 0;

check('核心缺陷：无限期潜水时传入 sleepMs，定时必须留下', () => {
  const current = { mode: 'diving', infinite: true, sleepUntil: null };
  const r = resolveWakeTiming({ current, input: { mode: 'diving', sleepMs: 30 * 60000 }, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.infinite, false);
  assert.equal(r.sleepUntil, iso(NOW + 30 * 60000));
});

check('核心缺陷：无限期潜水时传入 sleepUntil，定时必须留下', () => {
  const target = NOW + 45 * 60000;
  const current = { mode: 'diving', infinite: true, sleepUntil: null };
  const r = resolveWakeTiming({ current, input: { mode: 'diving', sleepUntil: iso(target) }, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.infinite, false);
  assert.equal(r.sleepUntil, iso(target));
});

check('已排好的定时唤醒：只改 mode 不清时间点', () => {
  const kept = iso(NOW + 2 * 3600 * 1000);
  const current = { mode: 'active', infinite: false, sleepUntil: kept };
  const r = resolveWakeTiming({ current, input: { mode: 'diving' }, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.infinite, false);
  assert.equal(r.sleepUntil, kept);
});

check('显式 infinite=true 才允许清空定时器', () => {
  const current = { mode: 'diving', infinite: false, sleepUntil: iso(NOW + 3600000) };
  const r = resolveWakeTiming({ current, input: { infinite: true }, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.infinite, true);
  assert.equal(r.sleepUntil, null);
});

check('infinite=true 与定时同传 → 报错，不静默丢一个', () => {
  const r = resolveWakeTiming({ current: {}, input: { infinite: true, sleepMs: 600000 }, mode: 'diving', now: NOW, limits });
  assert.equal(r.ok, false);
  assert.match(r.error, /互斥/);
});

check('mode=active：无定时器（这是显式语义）', () => {
  const current = { mode: 'diving', infinite: false, sleepUntil: iso(NOW + 3600000) };
  const r = resolveWakeTiming({ current, input: { mode: 'active' }, mode: 'active', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.infinite, true);
  assert.equal(r.sleepUntil, null);
});

check('什么都没传且当前是无限期潜水 → 保持原样', () => {
  const r = resolveWakeTiming({ current: { infinite: true, sleepUntil: null }, input: {}, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.infinite, true);
  assert.equal(r.sleepUntil, null);
});

check('什么都没传且原定时器仍在未来 → 原样保留', () => {
  const kept = iso(NOW + 90 * 60000);
  const r = resolveWakeTiming({ current: { infinite: false, sleepUntil: kept }, input: {}, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.sleepUntil, kept);
  assert.equal(r.source, 'inherit');
});

check('原定时器已过期 → 退回推荐默认时长（不会留一个过去的时间点）', () => {
  const r = resolveWakeTiming({ current: { infinite: false, sleepUntil: iso(NOW - 60000) }, input: {}, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(r.ok, true);
  assert.equal(r.sleepUntil, iso(NOW + limits.recommendedSleepMinMs));
});

check('sleepMs 受 sleepMinMs / sleepMaxMs 夹取', () => {
  const lo = resolveWakeTiming({ current: {}, input: { sleepMs: 1000 }, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(lo.sleepUntil, iso(NOW + limits.sleepMinMs));
  const hi = resolveWakeTiming({ current: {}, input: { sleepMs: 99 * 3600000 }, mode: 'diving', now: NOW, limits, random: fixedRandom });
  assert.equal(hi.sleepUntil, iso(NOW + limits.sleepMaxMs));
});

check('sleepUntil 解析失败 → 报错，不静默改成随机时长', () => {
  const r = resolveWakeTiming({ current: {}, input: { sleepUntil: '明晚吧' }, mode: 'diving', now: NOW, limits });
  assert.equal(r.ok, false);
  assert.match(r.error, /无法解析/);
});

check('"HH:MM" 按本机时区解释：晚于当前 → 今天，早于当前 → 明天', () => {
  const later = parseSleepUntil('23:40', NOW);
  assert.equal(later.ok, true);
  assert.equal(new Date(later.ts).getHours(), 23);
  assert.equal(new Date(later.ts).getDate(), new Date(NOW).getDate());

  const earlier = parseSleepUntil('08:00', NOW);
  assert.equal(earlier.ok, true);
  assert.equal(new Date(earlier.ts).getDate(), new Date(NOW).getDate() + 1);
});

check('"HH:MM:SS" 与非法的 25:00 分别解析/拒绝', () => {
  assert.equal(parseSleepUntil('07:05:30', NOW).ok, true);
  assert.equal(parseSleepUntil('25:00', NOW).ok, false);
});

console.log(`wake-timing replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
