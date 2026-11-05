// 唤醒门的纯策略（v2）。
//
// v1 → v2 的变化（对应 behavior-spec §2 / 改造方案 §5.2）：
//   · 明确请求（@、明确提问）不再经过随机忽略；
//   · 定时类唤醒（timeout / replyCheck / proactiveCheck / poke / bootstrap）不抽随机；
//   · 随机忽略只作用于"提及名字 / 关键词 / 话题词 / 普通概率"这几类软触发；
//   · 私聊默认可配置：privateAlwaysReply=true 时必回，false 时按 ignoreProbability 抽。
//
// 纯函数、无副作用、随机源可注入，供 tools/replay 的确定性回放使用。

/** 忽略原因码（写入结构化日志） */
export const REASON_CODES = {
  ACCEPTED: 'ACCEPTED',
  IGNORED_AT_PROBABILITY: 'IGNORED_AT_PROBABILITY',
  IGNORED_SOFT_PROBABILITY: 'IGNORED_SOFT_PROBABILITY',
  IGNORED_PRIVATE_PROBABILITY: 'IGNORED_PRIVATE_PROBABILITY',
};

/** 明确请求：一律受理，不做随机忽略。 */
export const EXPLICIT_REASONS = new Set(['atMention', 'question', 'poke', 'continuation', 'nightBacklog']);

/** 定时/系统类唤醒：不受随机忽略影响（否则等于随机丢弃定时器）。 */
export const TIMER_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap']);

/** 软触发：只有这些才会抽随机忽略。 */
export const SOFT_REASONS = new Set(['nameMention', 'keyword', 'topicKeywords', 'probability']);

/** 是否属于"不受随机忽略"的原因。 */
export function isExemptFromIgnore(reason, cfg) {
  if (!reason) return true;
  if (reason === 'private') {
    const always = cfg?.socialV2?.wake?.privateAlwaysReply;
    return always !== false;
  }
  return EXPLICIT_REASONS.has(reason) || TIMER_REASONS.has(reason);
}

/** 取该唤醒原因对应的忽略概率；被豁免的原因返回 0。 */
export function ignoreProbabilityFor(reason, cfg) {
  if (!reason || isExemptFromIgnore(reason, cfg)) return 0;
  const wake = cfg?.socialV2?.wake ?? {};
  const raw = reason === 'private' ? wake.ignoreProbability : (reason === 'atMention' ? wake.ignoreAtMentionProbability : wake.ignoreProbability);
  const p = Number(raw);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/**
 * 决定这条唤醒是接受还是忽略。
 * @param {{reason: string, cfg: object, random?: () => number}} input
 * @returns {{action: 'accept'|'ignore', reasonCode: string, probability: number, policyVersion: string}}
 */
export function decideWakeGate({ reason, cfg, random = Math.random }) {
  const VERSION = 'wake-policy/2';
  if (!reason) return { action: 'accept', reasonCode: REASON_CODES.ACCEPTED, probability: 0, policyVersion: VERSION };
  const p = ignoreProbabilityFor(reason, cfg);
  if (p <= 0) return { action: 'accept', reasonCode: REASON_CODES.ACCEPTED, probability: 0, policyVersion: VERSION };
  const roll = Number(random());
  if (Number.isFinite(roll) && roll < p) {
    const reasonCode = reason === 'private'
      ? REASON_CODES.IGNORED_PRIVATE_PROBABILITY
      : (reason === 'atMention' ? REASON_CODES.IGNORED_AT_PROBABILITY : REASON_CODES.IGNORED_SOFT_PROBABILITY);
    return { action: 'ignore', reasonCode, probability: p, policyVersion: VERSION };
  }
  return { action: 'accept', reasonCode: REASON_CODES.ACCEPTED, probability: p, policyVersion: VERSION };
}
