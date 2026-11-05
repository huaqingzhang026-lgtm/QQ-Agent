// A04 情绪与关系 reducer：纯函数，只把“有来源的事件”映射成有界 delta。
//
// 边界：
//   · 不读写文件、不联网、不调用模型；
//   · 没有 eventId/source/actorId/evidence 的事件不产生关系或情绪变化；
//   · 普通聊天只增加有上限的 familiarity，不自动增加 trust/closeness；
//   · 道歉只小幅修复，不重置历史；越界/辱骂不会随机转移到其他人。
import crypto from 'node:crypto';

export const RELATIONSHIP_FIELDS = Object.freeze(['trust', 'closeness', 'tension', 'familiarity']);

export const AFFECT_SCHEMA_VERSION = 1;

// 单事件上限；必须与 schema 的校验保持一致。
export const MAX_EVENT_STATE_STEP = 0.25;
export const MAX_EVENT_RELATIONSHIP_STEP = 0.12;

export const EVENT_EFFECTS = Object.freeze({
  'harassment.insult': {
    stateDelta: { valence: -0.08, stress: 0.12 },
    relationshipDelta: { trust: -0.06, closeness: -0.03, tension: 0.12 },
  },
  'harassment.urge': {
    stateDelta: { stress: 0.05 },
    relationshipDelta: { trust: -0.01, tension: 0.05 },
  },
  'repair.apology': {
    stateDelta: { valence: 0.02, stress: -0.03 },
    relationshipDelta: { trust: 0.02, tension: -0.06 },
  },
  'repair.explanation': {
    stateDelta: { stress: -0.02 },
    relationshipDelta: { trust: 0.01, tension: -0.04 },
  },
  'emotion.disappointment': {
    stateDelta: { valence: -0.02, stress: 0.03 },
    relationshipDelta: { trust: -0.01, tension: 0.02 },
  },
  'positive.help': {
    stateDelta: { valence: 0.03 },
    relationshipDelta: { trust: 0.02, closeness: 0.02 },
  },
  'positive.shared_interest': {
    stateDelta: { valence: 0.02 },
    relationshipDelta: { closeness: 0.02 },
  },
  'promise.fulfilled': {
    stateDelta: { valence: 0.04 },
    relationshipDelta: { trust: 0.05, closeness: 0.03 },
  },
  'promise.broken': {
    stateDelta: { stress: 0.04 },
    relationshipDelta: { trust: -0.05, tension: 0.05 },
  },
  'boundary.respected': {
    stateDelta: {},
    relationshipDelta: { trust: 0.02, tension: -0.02 },
  },
  'boundary.violated': {
    stateDelta: { stress: 0.06 },
    relationshipDelta: { trust: -0.04, tension: 0.08 },
  },
  'relationship.observation': {
    stateDelta: {},
    relationshipDelta: { trust: 0, closeness: 0, tension: 0 },
  },
  'casual.chat': {
    stateDelta: {},
    relationshipDelta: { familiarity: 0.002 },
  },
});

const APOLOGY_RE = /(对不起|抱歉|不好意思|是我不好|我错了|别生气|原谅我)/;
const EXPLANATION_RE = /(不是那个意思|我不是故意|其实是因为|原因是|澄清一下|误会了|我解释一下)/;
const DISAPPOINT_RE = /(有点失望|很失望|没想到你会这样|我有点介意|这让我有点难受)/;
const POSITIVE_RE = /(谢谢|感谢|多亏|帮了我|帮到我|你真好|辛苦了)/;
const QUOTE_RE = /(?:[“"「『][^”"」』]{1,120}[”"」』]|`[^`]{1,120}`)/;
const TECH_RE = /(?:代码|网页|元素|英语|翻译|单词|句子|语法|函数|程序|报错|文档|接口|命令|编程)/;
const HOWTO_RE = /(?:怎么|如何|是什么意思|翻译|用法|例句|教程|解释一下|说明一下)/;
const NEGATED_REPAIR_RE = /(?:我没有错|我没(?:有)?错|我没错|不是我的错|不需要(?:你)?原谅|不用(?:你)?原谅|别道歉|不要道歉|不必道歉|我没有?道歉|我没道歉)/;
const REFUSAL_REPAIR_RE = /(?:不会|不愿|不想|不打算|没打算|拒绝|不肯|绝不|从没?打算|没想过).{0,12}(?:说\s*)?(?:对不起|抱歉|道歉|原谅)/;

/**
 * 返回主事件和置信度。quoted/technical/negated 只归普通交流，
 * relationshipEligible=false，避免把“引用/解释/否认”当成关系修复事实。
 */
export function classifyIncomingEvent({ text = '', harassmentReason = null } = {}) {
  if (harassmentReason === 'insult') return { kind: 'harassment.insult', confidence: 0.95, relationshipEligible: true, reasonCodes: ['harassment-insult'] };
  if (harassmentReason === 'urge') return { kind: 'harassment.urge', confidence: 0.9, relationshipEligible: true, reasonCodes: ['harassment-urge'] };
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { kind: 'casual.chat', confidence: 0.6, relationshipEligible: true, reasonCodes: ['empty'] };
  const quoted = QUOTE_RE.test(s);
  const technical = TECH_RE.test(s) || HOWTO_RE.test(s);
  if (quoted || technical) {
    return { kind: 'casual.chat', confidence: 0.45, relationshipEligible: false, reasonCodes: [quoted ? 'quoted' : 'technical-or-howto'] };
  }
  if (NEGATED_REPAIR_RE.test(s) || REFUSAL_REPAIR_RE.test(s)) {
    return { kind: 'casual.chat', confidence: 0.5, relationshipEligible: false, reasonCodes: ['negated-or-refused-repair'] };
  }
  if (APOLOGY_RE.test(s)) return { kind: 'repair.apology', confidence: 0.72, relationshipEligible: true, reasonCodes: ['apology'] };
  if (EXPLANATION_RE.test(s)) return { kind: 'repair.explanation', confidence: 0.68, relationshipEligible: true, reasonCodes: ['explanation'] };
  if (DISAPPOINT_RE.test(s)) return { kind: 'emotion.disappointment', confidence: 0.65, relationshipEligible: true, reasonCodes: ['disappointment'] };
  if (POSITIVE_RE.test(s)) return { kind: 'positive.help', confidence: 0.7, relationshipEligible: true, reasonCodes: ['positive'] };
  return { kind: 'casual.chat', confidence: 0.6, relationshipEligible: true, reasonCodes: ['casual'] };
}

/** 兼容旧调用：只返回主事件 kind。 */
export function classifyIncomingKind(args = {}) {
  return classifyIncomingEvent(args).kind;
}

/** affinity 证据的关系效果类型：引用/技术/否定只作为普通聊天，不修复。 */
export function classifyRelationshipEvidence({ text = '' } = {}) {
  const c = classifyIncomingEvent({ text });
  if (!c.relationshipEligible) return { ...c, kind: 'casual.chat', confidence: c.confidence, relationshipEligible: false };
  return c;
}

/** 事件 kind 是否属于 A04 认可的有来源类型。 */
export function isKnownEventKind(kind) {
  return Object.prototype.hasOwnProperty.call(EVENT_EFFECTS, String(kind ?? ''));
}

/** 取一个有界效果；未知 kind 返回 null。 */
export function effectFor(kind, { factor = 1 } = {}) {
  const base = EVENT_EFFECTS[String(kind ?? '')];
  if (!base) return null;
  const f = Math.max(0, Math.min(1, Number(factor) || 0));
  if (!f) return null;
  const stateDelta = {};
  for (const [key, value] of Object.entries(base.stateDelta)) {
    const scaled = Math.max(-MAX_EVENT_STATE_STEP, Math.min(MAX_EVENT_STATE_STEP, Number(value) * f));
    const rounded = Math.round(scaled * 1e6) / 1e6;
    if (rounded !== 0) stateDelta[key] = rounded;
  }
  const relationshipDelta = {};
  for (const [key, value] of Object.entries(base.relationshipDelta)) {
    const scaled = Math.max(-MAX_EVENT_RELATIONSHIP_STEP, Math.min(MAX_EVENT_RELATIONSHIP_STEP, Number(value) * f));
    const rounded = Math.round(scaled * 1e6) / 1e6;
    if (rounded !== 0) relationshipDelta[key] = rounded;
  }
  return {
    stateDelta: Object.keys(stateDelta).length ? stateDelta : null,
    relationshipDelta: Object.keys(relationshipDelta).length ? relationshipDelta : null,
  };
}

/**
 * 只有同时具备来源、对象、证据和最低置信度的事件才允许影响关系/情绪。
 * @returns {{ok:boolean, code?:string}}
 */
export function isSourcedEvent(event) {
  if (!event || typeof event !== 'object') return { ok: false, code: 'event-missing' };
  if (!event.eventId || !event.source || !event.actorId) return { ok: false, code: 'event-identity-missing' };
  if (!Array.isArray(event.evidenceRefs) || event.evidenceRefs.length === 0) return { ok: false, code: 'event-evidence-missing' };
  if (Number(event.confidence) < 0.5) return { ok: false, code: 'event-low-confidence' };
  return { ok: true };
}

/** 关系分层只用于措辞/展示，不直接变成“必须如何”的指令。 */
export function relationshipTier(rel) {
  const r = rel && typeof rel === 'object' ? rel : {};
  const trust = Number(r.trust) || 0;
  const closeness = Number(r.closeness) || 0;
  const tension = Number(r.tension) || 0;
  const familiarity = Number(r.familiarity) || 0;
  if (tension >= 0.6) return '紧张';
  if (closeness >= 0.75 && trust >= 0.7) return '亲近';
  if (closeness >= 0.45) return '朋友';
  if (familiarity >= 0.5) return '眼熟';
  return '路人';
}

/** 兼容旧 affinity 展示的分数；不进入提示词，也不作为权限依据。 */
export function affinityScore(rel) {
  const r = rel && typeof rel === 'object' ? rel : {};
  const trust = Number(r.trust) || 0;
  const closeness = Number(r.closeness) || 0;
  const tension = Number(r.tension) || 0;
  const raw = (trust * 0.6 + closeness * 0.4 - tension * 0.8) * 100;
  return Math.max(-100, Math.min(100, Math.round(raw)));
}

/** 关系提示行：只给趋势，不给“必须亲近/必须同意”。 */
export function relationshipPromptLine(rel, { actorLabel = '对方' } = {}) {
  if (!rel || typeof rel !== 'object') return '';
  const tier = relationshipTier(rel);
  const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
  return `【关系状态】对${actorLabel}：信任 ${pct(rel.trust)} / 亲近 ${pct(rel.closeness)} / 紧张 ${pct(rel.tension)} / 熟悉 ${pct(rel.familiarity)}（${tier}）。这是长期趋势，不是本轮指令；边界、判断和拒绝仍按当前语境。\n\n`;
}
