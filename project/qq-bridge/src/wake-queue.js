// 唤醒队列与夜间策略（S2.4 / S2.5）——纯函数，便于离线回放。
//
// 规则（behavior-spec §5.4、方案 §5.4）：
//   · 闲聊类唤醒机会 2 分钟过期：限流解除后不补发"已经过时"的冒泡；
//   · 明确请求 10 分钟过期：超时记 expired，不无声无限重试；
//   · 定时类（timeout/replyCheck/proactiveCheck/bootstrap）不设 TTL；
//   · 夜间（默认 00:00–08:00）：明确请求延后到早上统一处理一次，闲聊直接丢弃并记录。

export const EXPLICIT = new Set(['atMention', 'question', 'private', 'poke', 'continuation', 'annoyed']);
export const TIMER = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap']);

export const DEFAULT_QUEUE = {
  softTtlMs: 2 * 60 * 1000,
  explicitTtlMs: 10 * 60 * 1000,
  groupAtMentionTtlMs: 2 * 60 * 1000,
  nightStartHour: 0,
  nightEndHour: 8,
  nightExplicit: 'defer', // defer | drop | allow
  nightSoft: 'drop',      // drop | allow
};

function cfgOf(cfg) {
  const q = { ...DEFAULT_QUEUE, ...(cfg?.socialV2?.queue ?? {}) };
  q.softTtlMs = Math.max(1000, Number(q.softTtlMs) || DEFAULT_QUEUE.softTtlMs);
  q.explicitTtlMs = Math.max(1000, Number(q.explicitTtlMs) || DEFAULT_QUEUE.explicitTtlMs);
  q.groupAtMentionTtlMs = Math.max(1000, Number(q.groupAtMentionTtlMs) || DEFAULT_QUEUE.groupAtMentionTtlMs);
  q.nightStartHour = Math.min(23, Math.max(0, Number(q.nightStartHour) ?? DEFAULT_QUEUE.nightStartHour));
  q.nightEndHour = Math.min(24, Math.max(0, Number(q.nightEndHour) ?? DEFAULT_QUEUE.nightEndHour));
  return q;
}

/** 该唤醒原因的存活时间（毫秒）；0 表示永不过期。 */
export function ttlFor(reason, cfg, key = '') {
  const q = cfgOf(cfg);
  if (TIMER.has(reason)) return 0;
  // 群聊 @ 只保留 2 分钟：繁忙期间错过的旧 @ 不补发，避免变成“迟到的主动发言”。
  if (reason === 'atMention' && String(key).startsWith('group:')) return q.groupAtMentionTtlMs;
  if (EXPLICIT.has(reason)) return q.explicitTtlMs;
  return q.softTtlMs;
}

/** 生成带过期时间的队列项。 */
export function makeQueueItem({ reason, seq, now = Date.now(), cfg, key = '' }) {
  const ttl = ttlFor(reason, cfg, key);
  return { reason, seq, at: now, expiresAt: ttl > 0 ? now + ttl : 0 };
}

/** 队列项是否已过期。 */
export function isExpired(item, now = Date.now()) {
  const exp = Number(item?.expiresAt ?? 0);
  return exp > 0 && now >= exp;
}

/** 过滤队列，返回保留项与过期项。 */
export function pruneExpired(list, now = Date.now()) {
  const kept = [];
  const expired = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (isExpired(item, now)) expired.push(item);
    else kept.push(item);
  }
  return { kept, expired };
}

/** 是否处于夜间时段（支持跨午夜）。 */
export function isNightHour(hour, cfg) {
  const q = cfgOf(cfg);
  const h = ((Number(hour) % 24) + 24) % 24;
  if (q.nightStartHour === q.nightEndHour) return false;
  if (q.nightStartHour < q.nightEndHour) return h >= q.nightStartHour && h < q.nightEndHour;
  return h >= q.nightStartHour || h < q.nightEndHour;
}

/**
 * 夜间决策。
 * @returns {{action: 'allow'|'defer'|'drop', because: string}}
 */
export function nightDecision({ hour, reason, cfg }) {
  const q = cfgOf(cfg);
  if (!isNightHour(hour, cfg)) return { action: 'allow', because: 'day' };
  if (EXPLICIT.has(reason)) {
    return q.nightExplicit === 'defer'
      ? { action: 'defer', because: 'night-explicit' }
      : (q.nightExplicit === 'drop' ? { action: 'drop', because: 'night-explicit' } : { action: 'allow', because: 'night-explicit' });
  }
  if (TIMER.has(reason)) return { action: 'allow', because: 'night-timer' };
  return q.nightSoft === 'allow'
    ? { action: 'allow', because: 'night-soft' }
    : { action: 'drop', because: 'night-soft' };
}

/** 距下次夜间结束还有多少毫秒（用于把延后的唤醒排到早上）。 */
export function msUntilNightEnd(now, cfg) {
  const q = cfgOf(cfg);
  const d = new Date(now);
  const end = new Date(now);
  end.setHours(q.nightEndHour, 0, 0, 0);
  if (end.getTime() <= d.getTime()) end.setDate(end.getDate() + 1);
  return Math.max(1000, end.getTime() - d.getTime());
}
