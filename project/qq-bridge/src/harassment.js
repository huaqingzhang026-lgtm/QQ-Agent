// 骚扰分（S2.3）：与"情绪分 annoyance"分离的纯判定。
//
// 语义（behavior-spec §3）：
//   · 普通发言不产生骚扰分；
//   · 正常 @ 本身不产生骚扰分；
//   · 只有"请求还没回就连续追问"或"带辱骂"才加分；
//   · 分数只用于触发冷处理，不直接决定语气（语气看 annoyance）。

/** 默认参数；可被 config.socialV2.harassment 覆盖。 */
export const DEFAULT_HARASSMENT = {
  enabled: true,
  windowMs: 120000,
  urgeCount: 3,
  urgeScore: 1,
  insultScore: 3,
  decayPerMin: 0.3,
  muteThreshold: 8,
  muteMinutes: 30,
};

const INSULT_RE = /(傻逼|煞笔|滚蛋|滚出去|废物|垃圾玩意|你妈|脑残|贱人|去死)/;

export function normalizeHarassmentConfig(cfg) {
  const c = { ...DEFAULT_HARASSMENT, ...(cfg ?? {}) };
  c.enabled = c.enabled !== false;
  c.windowMs = Math.max(10000, Number(c.windowMs) || DEFAULT_HARASSMENT.windowMs);
  c.urgeCount = Math.max(2, Number(c.urgeCount) || DEFAULT_HARASSMENT.urgeCount);
  c.urgeScore = Math.max(1, Number(c.urgeScore) || DEFAULT_HARASSMENT.urgeScore);
  c.insultScore = Math.max(1, Number(c.insultScore) || DEFAULT_HARASSMENT.insultScore);
  c.decayPerMin = Number.isFinite(Number(c.decayPerMin)) ? Number(c.decayPerMin) : DEFAULT_HARASSMENT.decayPerMin;
  c.muteThreshold = Math.min(10, Math.max(1, Number(c.muteThreshold) || DEFAULT_HARASSMENT.muteThreshold));
  c.muteMinutes = Math.max(1, Number(c.muteMinutes) || DEFAULT_HARASSMENT.muteMinutes);
  return c;
}

/** 时间衰减：读取时计算，不重复扣减。 */
export function decayedScore(score, updatedAt, now, decayPerMin) {
  const s = Number(score) || 0;
  const at = Number(updatedAt) || 0;
  const elapsedMin = Math.max(0, (now - at) / 60000);
  return Math.max(0, s - elapsedMin * (Number(decayPerMin) || 0));
}

/**
 * 判定一条消息是否产生骚扰分。
 * @param {{windowCount: number, repliedSince: boolean, text: string, cfg?: object}} input
 * @returns {{added: number, reason: 'insult'|'urge'|null}}
 */
export function classifyMessage({ windowCount, repliedSince, text, cfg }) {
  const c = normalizeHarassmentConfig(cfg);
  // 空文本（图片/表情等占位）不算催促：避免连发图片被误判成骚扰。
  const raw = String(text ?? '');
  if (!raw.trim()) return { added: 0, reason: null };
  if (INSULT_RE.test(raw)) return { added: c.insultScore, reason: 'insult' };
  if (Number(windowCount) >= c.urgeCount && repliedSince !== true) return { added: c.urgeScore, reason: 'urge' };
  return { added: 0, reason: null };
}

/**
 * 是否触发自动冷落。
 * @returns {{mute: boolean, minutes: number, threshold: number}}
 */
export function decideMute({ score, cfg }) {
  const c = normalizeHarassmentConfig(cfg);
  const muted = Number(score) >= c.muteThreshold;
  return { mute: muted, minutes: c.muteMinutes, threshold: c.muteThreshold };
}


/**
 * 早退判定必须是"衰减后的有效分"：早期实现直接读 raw score，
 * 导致到过阈值的号在衰减代码之前就被 return，永远等不到归零。
 * @returns {{skip: boolean, score: number, threshold: number}}
 */
export function shouldStaySilent(record, now = Date.now(), cfg) {
  const c = normalizeHarassmentConfig(cfg);
  const score = decayedScore(record?.score, record?.at, now, c.decayPerMin);
  return { skip: score >= c.muteThreshold, score: Math.round(score * 10) / 10, threshold: c.muteThreshold };
}


/** 这条消息是不是"对她说的"（决定是否进入骚扰窗口）。 */
export function isDirectedAtMe({ atSelf = false, quoteSelf = false, text = '', selfNickname = '' } = {}) {
  if (atSelf || quoteSelf) return true;
  const name = String(selfNickname ?? '').trim();
  if (!name) return false;
  return String(text ?? '').includes(name);
}


/**
 * 一条消息对骚扰分的完整影响（桥接与测试共用同一条路径）：
 * 只有 directedAtMe 才进入窗口；窗口达到阈值且她还没回 → 加分；辱骂直接加。
 * @returns {{record: {score:number, at:number, window:number[]}, added: number, reason: string|null}}
 */
export function applyMessage({ record = {}, window = [], directedAtMe = false, repliedSince = false, text = '', cfg, now = Date.now() }) {
  const c = normalizeHarassmentConfig(cfg);
  const win = (Array.isArray(window) ? window : []).filter((x) => now - Number(x) < c.windowMs);
  if (directedAtMe) win.push(now);
  const prevScore = decayedScore(record?.score, record?.at, now, c.decayPerMin);
  const verdict = directedAtMe ? classifyMessage({ windowCount: win.length, repliedSince, text, cfg: c }) : { added: 0, reason: null };
  const score = Math.min(10, Math.round((prevScore + verdict.added) * 10) / 10);
  return { record: { score, at: now, window: win.slice(-10) }, added: verdict.added, reason: verdict.reason };
}
