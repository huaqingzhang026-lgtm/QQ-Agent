// 巡游看小主播：选房、按天计时、会话轮换（纯函数）。

export function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 过滤出"人少"的候选：在线人气在 [min,max]，排除自己人和黑名单。 */
export function pickCandidates(list, { maxViewers = 100, minViewers = 5, excludeUids = [], excludeRooms = [] } = {}) {
  const exU = new Set(excludeUids.map(String));
  const exR = new Set(excludeRooms.map(String));
  return (Array.isArray(list) ? list : []).filter((r) => {
    const online = Number(r?.online);
    if (!Number.isFinite(online) || online < minViewers || online > maxViewers) return false;
    if (exU.has(String(r?.uid ?? ''))) return false;
    if (exR.has(String(r?.roomid ?? ''))) return false;
    return Boolean(r?.roomid);
  });
}

export function budgetState(state = {}, { dailyMinutes = 180, now = Date.now() } = {}) {
  const day = todayKey(now);
  const usedSeconds = state.date === day ? Number(state.usedSeconds) || 0 : 0;
  const total = Math.max(0, Number(dailyMinutes) || 0) * 60;
  return { day, usedSeconds, total, remainSeconds: Math.max(0, total - usedSeconds), exhausted: usedSeconds >= total };
}

/** 该不该换台：超时 / 下播 / 暂停。 */
export function shouldRotate({ session = {}, now = Date.now(), sessionMinutes = 20, roomLive = true } = {}) {
  if (session?.roomId == null) return false;
  if (roomLive === false) return true;
  const started = Number(session.startedAt) || 0;
  if (!started) return true;
  return now - started >= Math.max(1, sessionMinutes) * 60 * 1000;
}

export function inActiveHours(now = Date.now(), { start = 10, end = 24 } = {}) {
  const h = new Date(now).getHours();
  if (start === end) return true;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}
