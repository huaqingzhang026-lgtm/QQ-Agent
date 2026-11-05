// A05 上下文查询合成：不再只取末句前 80 字。
//
// 输入是候选消息、近期会话和未决承诺；输出是稳定的检索查询和来源信号。
// 这里不调用模型、不读文件、不查库。

export const MEMORY_CONTEXT_VERSION = 1;

function textOf(m) {
  return String(m?.plain ?? m?.text ?? '').replace(/\s+/g, ' ').trim();
}

function userMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isSelf);
}

/** 从最近消息中抓“上次/昨天/明天/那个/这件事”等指代，便于接回旧事件。 */
export function referenceTerms(text = '') {
  const s = String(text ?? '');
  const out = [];
  const rules = [
    [/那个([^，。？!！\s]{0,12})/gu, 'reference'],
    [/这件事|这事|上次|昨天|前天|明天|后天|周末|下周/gu, 'time-reference'],
    [/还没|没弄|没做完|待办|记得|别忘了/gu, 'unfinished'],
  ];
  for (const [re, tag] of rules) {
    for (const m of s.matchAll(re)) {
      const term = String(m[0] ?? '').trim();
      if (term.length >= 2) out.push({ term: term.slice(0, 24), tag });
    }
  }
  return out.slice(0, 6);
}

/**
 * 合成记忆查询：
 *   · 当前请求（完整有效长度，而非固定末句 80 字）
 *   · 最近两个未读上下文
 *   · 未决承诺中的具体对象
 *   · 指代/未完成信号
 */
export function buildMemoryQuery({ latestText = '', recentMessages = [], commitments = [] } = {}) {
  const latest = String(latestText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const users = userMessages(recentMessages).slice(-4).map((m) => ({
    text: textOf(m),
    actorId: String(m.userId ?? m.actorId ?? ''),
    sender: String(m.sender ?? m.actorName ?? ''),
    time: Number(m.time ?? 0) || 0,
  })).filter((m) => m.text);
  const previous = users.length > 1 ? users[users.length - 2].text.slice(0, 120) : '';
  const unresolved = (Array.isArray(commitments) ? commitments : [])
    .filter((c) => ['proposed', 'active', 'uncertain'].includes(String(c?.status ?? '')))
    .slice(0, 3)
    .map((c) => ({ id: String(c.id ?? ''), text: clean(c.text), status: String(c.status ?? '') }));
  const references = [...referenceTerms(latest), ...referenceTerms(previous)].slice(0, 6);
  const parts = [latest];
  if (previous) parts.push(previous);
  for (const c of unresolved) parts.push(c.text);
  for (const r of references) parts.push(r.term);
  const query = [...new Set(parts.map((x) => String(x ?? '').trim()).filter(Boolean))].join(' / ').slice(0, 480);
  return {
    version: MEMORY_CONTEXT_VERSION,
    query,
    latest,
    previous,
    unresolved,
    references,
    usedMessages: users.length,
    hasReferenceSignal: references.length > 0,
    hasUnresolvedCommitment: unresolved.length > 0,
  };
}

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120); }
