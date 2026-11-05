// 跨群对话记忆（S2/S6）：让两个群"知道彼此刚聊了什么"，但**绝不把私聊带进群**。
//
// 规则：
//   · 只聚合 **group:** 会话；private 永远不参与；
//   · 只取最近 windowMs 内、每群最多 perGroup 条、总数最多 maxLines 条；
//   · 只输出"群友名：内容"的短行，不带未读状态、不带令牌；
//   · 当前群自己的消息不重复注入（避免和本群上下文重复）。

const DEFAULT = { windowMs: 90 * 60 * 1000, perGroup: 4, maxLines: 8, maxCharsPerLine: 80 };

function short(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * @param {{conversations: Record<string, any>, currentKey: string, now?: number, opts?: object}} input
 * @returns {{lines: string[], groups: number}}
 */
export function buildCrossGroupDigest({ conversations, currentKey, now = Date.now(), opts = {} }) {
  const o = { ...DEFAULT, ...opts };
  const lines = [];
  let groups = 0;
  const keys = Object.keys(conversations ?? {}).filter((k) => k.startsWith('group:') && k !== currentKey);
  for (const key of keys) {
    const conv = conversations[key];
    const msgs = (conv?.recentMessages ?? [])
      .filter((m) => m && Number(m.time) >= now - o.windowMs)
      .slice(-o.perGroup);
    if (!msgs.length) continue;
    groups += 1;
    for (const m of msgs) {
      const who = m.isSelf ? '你' : short(m.sender || '群友', 12);
      const text = short(m.text || m.plain || '', o.maxCharsPerLine);
      if (!text) continue;
      lines.push(`[${key.replace(/^group:/, '群')}] ${who}：${text}`);
    }
  }
  return { lines: lines.slice(-o.maxLines), groups };
}

/** 拼成 prompt 段落；没有内容返回空串。 */
export function formatCrossGroupDigest(digest, { header = '【别的群刚聊到】' } = {}) {
  if (!digest || !digest.lines?.length) return '';
  return `${header}\n${digest.lines.join('\n')}\n（这是别的群的内容，可以接话，但别把私聊内容带出来；不确定是不是同一个人就别硬认。）\n\n`;
}
