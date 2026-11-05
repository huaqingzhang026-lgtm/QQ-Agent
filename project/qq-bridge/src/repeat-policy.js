// 复读判定（S2 补充）：同一句话在"上下文里已经复读过了"就不再跟。
//
// 规则：
//   · 只看纯文字（2~40 字），图片/表情/命令由调用方先挡掉；
//   · 历史里出现过同一句（默认 6 小时窗口）→ 不再复读；
//   · 她自己最近发过同一句（recentMessages 里 isSelf 且文本相同）→ 不再复读；
//   · 当前这波连续第 3 条相同 → 才允许复读（由调用方统计 count）。

export const DEFAULT_WINDOW_MS = 6 * 3600000;

/** 归一化：去首尾空白、压缩内部空白，降低"看起来一样"的误判。 */
export function normalizeRepeatText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {{text: string, count: number, history?: Array<{t:string, at:number}>,
 *          recentMessages?: Array<{text?:string, isSelf?:boolean, time?:number}>,
 *          now?: number, windowMs?: number, minCount?: number}} input
 * @returns {{repeat: boolean, reason: string}}
 */
export function decideRepeat({ text, count, history = [], recentMessages = [], now = Date.now(), windowMs = DEFAULT_WINDOW_MS, minCount = 3 }) {
  const t = normalizeRepeatText(text);
  if (!t) return { repeat: false, reason: 'empty' };
  if (t.length < 2 || t.length > 40) return { repeat: false, reason: 'length' };
  if (t.startsWith('/') || t.startsWith('@')) return { repeat: false, reason: 'command' };
  if (/^\[[^\]]*\]$/.test(t)) return { repeat: false, reason: 'media-placeholder' };

  if (Number(count) < Math.max(1, Number(minCount) || 3)) return { repeat: false, reason: 'not-enough' };

  const window = Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_WINDOW_MS;
  const seen = (Array.isArray(history) ? history : []).find((h) => normalizeRepeatText(h?.t) === t && now - Number(h?.at ?? 0) < window);
  if (seen) return { repeat: false, reason: 'already-repeated' };

  const selfSaid = (Array.isArray(recentMessages) ? recentMessages : []).some(
    (m) => m && m.isSelf && normalizeRepeatText(m.text ?? m.plain) === t && (!m.time || now - Number(m.time) < window)
  );
  if (selfSaid) return { repeat: false, reason: 'self-said-recently' };

  return { repeat: true, reason: 'ok' };
}

/** 记录一次复读，返回裁剪后的历史（新的在后）。 */
export function pushRepeatHistory(history, text, at = Date.now(), limit = 50) {
  const t = normalizeRepeatText(text);
  const list = Array.isArray(history) ? history.filter((x) => x && normalizeRepeatText(x.t) !== t) : [];
  list.push({ t, at });
  return list.slice(-Math.max(1, limit));
}
