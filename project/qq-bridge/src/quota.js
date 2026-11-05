// 群聊发言额度（S2/S3 补充）：每个会话每小时可发多少条、用尽后怎么收尾。
//
// 规则：
//   · 额度按会话独立（send.conversationOverrides[key].maxSendPerHour）；
//   · 用尽后进入潜水：第一次被 @ 回一句"借口"（我去忙了/洗衣服），之后潜水到额度恢复；
//   · 借口由内部发送，不占额度、不受发送限流（它本身就是"额度已满"的收尾）。
//
// 纯函数，便于回放。

export const DEFAULT_LEAVE_LINES = ['先不聊了，晚点再说', '我先停一下，回头聊', '现在不方便继续，改天聊', '下了，晚安'];

/**
 * @param {{cap: number, sendTimes: number[], now?: number}} input
 * @returns {{cap: number, used: number, remain: number, freeAt: number, full: boolean}}
 */
export function quotaState({ cap, sendTimes = [], maxPerMinute = 0, now = Date.now() }) {
  const capacity = Math.max(0, Number(cap) || 0);
  const times = (Array.isArray(sendTimes) ? sendTimes : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && now - t < 3600000)
    .sort((a, b) => a - b);
  const used = times.length;
  const minuteUsed = times.filter((t) => now - t < 60000).length;
  const minuteCap = Math.max(0, Number(maxPerMinute) || 0);
  return {
    cap: capacity,
    used,
    remain: Math.max(0, capacity - used),
    freeAt: times.length ? times[0] + 3600000 : now + 3600000,
    full: capacity > 0 && used >= capacity,
    minuteUsed,
    minuteCap,
    minuteFull: minuteCap > 0 && minuteUsed >= minuteCap,
  };
}

/** 解析某个会话的每小时额度（优先 conversationOverrides）。 */
export function capForConversation(key, sendCfg = {}) {
  const ovr = (sendCfg.conversationOverrides ?? {})[key] ?? {};
  return Number(ovr.maxSendPerHour ?? sendCfg.maxSendPerHour) || 0;
}

/** 每分钟上限（优先 conversationOverrides）。 */
export function minuteCapForConversation(key, sendCfg = {}) {
  const ovr = (sendCfg.conversationOverrides ?? {})[key] ?? {};
  return Number(ovr.maxSendPerMinute ?? sendCfg.maxSendPerMinute) || 0;
}

/** 是否该发"借口离开"：额度满、本次是被 @、且这一小时还没道别过。 */
export function shouldExcuse({ quota, atMe, excuseAt = 0, now = Date.now() }) {
  if (!quota?.full) return false;
  if (!atMe) return false;
  if (Number(excuseAt) > 0 && now - Number(excuseAt) < 3600000) return false;
  return true;
}

/** 选一句借口；配置为空时用默认。 */
export function pickLeaveLine(cfg, random = Math.random) {
  const lines = Array.isArray(cfg?.lines) && cfg.lines.length ? cfg.lines.map(String) : DEFAULT_LEAVE_LINES;
  const r = Number(random());
  const raw = Math.floor((Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0) * lines.length);
  const i = Math.max(0, Math.min(lines.length - 1, raw));
  return lines[i];
}

/** 潜水是否仍在生效。 */
export function inDive({ diveUntil = 0, now = Date.now() }) {
  return Number(diveUntil) > 0 && now < Number(diveUntil);
}
