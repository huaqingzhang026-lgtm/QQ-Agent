// 评论区互动额度：顶层评论按天、回复网友按小时（参照 QQ 群的额度思路）。

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function canTopComment({ state = {}, dailyMax = 10, now = Date.now() } = {}) {
  const used = state.date === dayKey(now) ? Number(state.topComments) || 0 : 0;
  return { allow: used < dailyMax, used, max: dailyMax };
}

export function noteTopComment(state = {}, now = Date.now()) {
  const day = dayKey(now);
  const used = state.date === day ? Number(state.topComments) || 0 : 0;
  return { ...state, date: day, topComments: used + 1 };
}

export function canReply({ state = {}, perHour = 20, minGapMs = 120000, now = Date.now() } = {}) {
  const list = (Array.isArray(state.replies) ? state.replies : []).map(Number).filter((t) => now - t < 3600000);
  const gapOk = !state.lastCommentAt || now - Number(state.lastCommentAt) >= minGapMs;
  return { allow: list.length < perHour && gapOk, used: list.length, max: perHour, gapOk };
}

export function noteReply(state = {}, now = Date.now()) {
  const list = (Array.isArray(state.replies) ? state.replies : []).map(Number).filter((t) => now - t < 3600000);
  list.push(now);
  return { ...state, replies: list.slice(-200), lastCommentAt: now };
}
