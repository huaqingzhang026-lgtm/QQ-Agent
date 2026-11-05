// 回放：唤醒队列 TTL 与夜间策略（wake-queue）。
//
// 断言重点（behavior-spec §5.4 / §2）：
//   · 闲聊 2 分钟过期、明确请求 10 分钟过期、定时器不过期；
//   · 过期项被过滤且可统计；
//   · 夜间：明确请求延后、闲聊丢弃、定时器放行；
//   · 跨午夜时段判定正确。

import assert from 'node:assert/strict';
import {
  ttlFor, makeQueueItem, isExpired, pruneExpired,
  isNightHour, nightDecision, msUntilNightEnd, DEFAULT_QUEUE,
} from '../../qq-bridge/src/wake-queue.js';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass += 1; } catch (e) { failures.push(`${name}: ${e.message}`); }
};

// ── TTL ────────────────────────────────────────────────────────────────────
check('闲聊 TTL = 2 分钟', () => {
  assert.equal(ttlFor('keyword', {}), DEFAULT_QUEUE.softTtlMs);
});
check('明确请求 TTL = 10 分钟', () => {
  assert.equal(ttlFor('atMention', {}), DEFAULT_QUEUE.explicitTtlMs);
  assert.equal(ttlFor('question', {}), DEFAULT_QUEUE.explicitTtlMs);
  assert.equal(ttlFor('continuation', {}), DEFAULT_QUEUE.explicitTtlMs);
});
check('定时器无 TTL', () => {
  assert.equal(ttlFor('timeout', {}), 0);
  assert.equal(ttlFor('replyCheck', {}), 0);
  assert.equal(ttlFor('proactiveCheck', {}), 0);
});
check('配置可覆盖 TTL', () => {
  assert.equal(ttlFor('keyword', { socialV2: { queue: { softTtlMs: 5000 } } }), 5000);
  assert.equal(ttlFor('atMention', { socialV2: { queue: { explicitTtlMs: 60000 } } }), 60000);
});

// ── 过期判定 ────────────────────────────────────────────────────────────────
check('刚入队未过期', () => {
  const item = makeQueueItem({ reason: 'keyword', seq: 1, now: 1000, cfg: {} });
  assert.equal(isExpired(item, 1000 + 60000), false);
});
check('超过 TTL 过期', () => {
  const item = makeQueueItem({ reason: 'keyword', seq: 1, now: 1000, cfg: {} });
  assert.equal(isExpired(item, 1000 + DEFAULT_QUEUE.softTtlMs), true);
});
check('定时器项永不过期', () => {
  const item = makeQueueItem({ reason: 'timeout', seq: 1, now: 1000, cfg: {} });
  assert.equal(isExpired(item, 1000 + 86400e3), false);
});
check('无 expiresAt 的旧项不过期', () => {
  assert.equal(isExpired({ reason: 'keyword', seq: 1 }, Date.now()), false);
});

// ── 队列剪枝 ────────────────────────────────────────────────────────────────
check('剪枝分离保留与过期', () => {
  const now = 1000000;
  const list = [
    makeQueueItem({ reason: 'keyword', seq: 1, now: now - 200000, cfg: {} }),   // 过期
    makeQueueItem({ reason: 'keyword', seq: 2, now: now - 10000, cfg: {} }),    // 保留
    makeQueueItem({ reason: 'atMention', seq: 3, now: now - 200000, cfg: {} }), // 保留（10min）
    makeQueueItem({ reason: 'timeout', seq: 4, now: now - 999999, cfg: {} }),   // 保留
  ];
  const { kept, expired } = pruneExpired(list, now);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].seq, 1);
  assert.equal(kept.length, 3);
});
check('空队列剪枝安全', () => {
  assert.deepEqual(pruneExpired(undefined, Date.now()), { kept: [], expired: [] });
});

// ── 夜间判定 ────────────────────────────────────────────────────────────────
check('00–08 是夜间', () => {
  assert.equal(isNightHour(0, {}), true);
  assert.equal(isNightHour(3, {}), true);
  assert.equal(isNightHour(7, {}), true);
});
check('08 点边界之后是白天', () => {
  assert.equal(isNightHour(8, {}), false);
  assert.equal(isNightHour(12, {}), false);
  assert.equal(isNightHour(23, {}), false);
});
check('跨午夜时段（22–6）', () => {
  const cfg = { socialV2: { queue: { nightStartHour: 22, nightEndHour: 6 } } };
  assert.equal(isNightHour(23, cfg), true);
  assert.equal(isNightHour(2, cfg), true);
  assert.equal(isNightHour(6, cfg), false);
  assert.equal(isNightHour(12, cfg), false);
});
check('start=end 视为没有夜间', () => {
  const cfg = { socialV2: { queue: { nightStartHour: 3, nightEndHour: 3 } } };
  assert.equal(isNightHour(3, cfg), false);
});

// ── 夜间决策 ────────────────────────────────────────────────────────────────
check('白天全部放行', () => {
  for (const reason of ['atMention', 'keyword', 'timeout']) {
    assert.equal(nightDecision({ hour: 12, reason, cfg: {} }).action, 'allow');
  }
});
check('夜间明确请求延后', () => {
  assert.equal(nightDecision({ hour: 3, reason: 'atMention', cfg: {} }).action, 'defer');
  assert.equal(nightDecision({ hour: 3, reason: 'question', cfg: {} }).action, 'defer');
  assert.equal(nightDecision({ hour: 3, reason: 'private', cfg: {} }).action, 'defer');
});
check('夜间闲聊丢弃', () => {
  assert.equal(nightDecision({ hour: 3, reason: 'keyword', cfg: {} }).action, 'drop');
  assert.equal(nightDecision({ hour: 3, reason: 'topicKeywords', cfg: {} }).action, 'drop');
});
check('夜间定时器放行', () => {
  assert.equal(nightDecision({ hour: 3, reason: 'replyCheck', cfg: {} }).action, 'allow');
});
check('夜间策略可配置为 drop 明确请求', () => {
  const cfg = { socialV2: { queue: { nightExplicit: 'drop' } } };
  assert.equal(nightDecision({ hour: 3, reason: 'atMention', cfg }).action, 'drop');
});
check('夜间策略可配置为放行闲聊', () => {
  const cfg = { socialV2: { queue: { nightSoft: 'allow' } } };
  assert.equal(nightDecision({ hour: 3, reason: 'keyword', cfg }).action, 'allow');
});

// ── 到早上的毫秒数 ──────────────────────────────────────────────────────────
check('22:00 距 08:00 约 10 小时', () => {
  const now = new Date(2026, 9, 22, 22, 0, 0, 0).getTime();
  const ms = msUntilNightEnd(now, {});
  assert.equal(Math.round(ms / 60000), 600);
});
check('凌晨 3 点距 8 点 5 小时', () => {
  const now = new Date(2026, 9, 22, 3, 0, 0, 0).getTime();
  assert.equal(Math.round(msUntilNightEnd(now, {}) / 60000), 300);
});

check('annoyed 有明确请求 TTL（10 分钟）', () => {
  assert.equal(ttlFor('annoyed', {}), 10 * 60 * 1000);
});

check('annoyed 夜间按明确请求处理（延后）', () => {
  assert.equal(nightDecision({ hour: 3, reason: 'annoyed', cfg: {} }).action, 'defer');
});

console.log(`wake-queue replay: ${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('全部通过');
