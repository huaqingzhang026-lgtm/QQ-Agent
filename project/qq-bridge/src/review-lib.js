// 夜间复盘：时间窗、取样、是否需要通知（纯函数）。

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 00:05 复盘"昨天"：窗口 = 昨天 00:00 ~ 今天 00:00。 */
export function reviewWindow(now = Date.now()) {
  const d = new Date(now);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const start = todayStart - 86400000;
  return { date: dayKey(start), start, end: todayStart };
}

export function inWindow(m, { start, end }) {
  const t = Number(m?.time ?? 0);
  return t >= start && t < end;
}

/** 收集她当天发过的话（按会话）。 */
export function collectSelfMessages(conversations, { start, end, max = 300 } = {}) {
  const out = [];
  for (const [key, conv] of Object.entries(conversations ?? {})) {
    for (const m of conv?.recentMessages ?? []) {
      if (!m?.isSelf || !inWindow(m, { start, end })) continue;
      const text = String(m.text ?? m.plain ?? '').trim();
      if (!text) continue;
      out.push({ key, text, time: Number(m.time) || 0, replyTo: m.replyTo ?? null });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(0, max);
}

/** 有高危或不可自修的问题才通知主人。 */
export function decideNotify(issues = []) {
  const list = Array.isArray(issues) ? issues : [];
  return list.some((i) => i && (i.severity === 'high' || i.fixable === false));
}

export function summarizeIssues(issues = []) {
  const list = Array.isArray(issues) ? issues : [];
  const high = list.filter((i) => i?.severity === 'high').length;
  const fixable = list.filter((i) => i?.fixable !== false).length;
  return { total: list.length, high, fixable, unfixable: list.length - fixable };
}
