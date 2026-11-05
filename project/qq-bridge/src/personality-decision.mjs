// A03 决策候选与语义校验：纯函数，不读写文件、不联网。
// 代码规则只处理能由上下文确定的直接事实；需要语义理解的候选由注入 provider 生成，
// 返回后必须用当前 clock、revision、证据和被引用上下文重新校验。
import { normalizeDecision, normalizeState, DECISION_INTENTS } from './personality-schema.mjs';

export const DECISION_VERSION = 1;
export const DEFAULT_DECISION_TTL_MS = 6 * 60 * 1000;
export const DEFAULT_MODEL_TIMEOUT_MS = 2500;
export const DEFAULT_MAX_DECISION_TTL_MS = 10 * 60 * 1000;
export const VISIBLE_ACTIONS = Object.freeze(['send_message', 'reply', 'poke', 'voice', 'sticker', 'image']);
export const ALLOWED_ACTIONS = new Set([...VISIBLE_ACTIONS, 'wait', 'mark_read', 'no_send']);
export const REQUEST_KINDS = new Set(['info', 'companionship', 'joke', 'command', 'collaboration', 'ending', 'boundary', 'unknown']);

const QUOTE_RE = /(?:[“"「『][^”"」』]{1,120}[”"」』]|`[^`]{1,120}`)/;
const ABOUT_RE = /(?:怎么|如何|为什么|是什么|什么是|翻译|解释|教程|示例|例子|含义|区别|代码|网页|元素|保存|安全|文档|学习|了解|哪种|哪个)/;
const BOUNDARY_TARGET_RE = /(?:把|将|发|给|告诉|查|找|拍|偷|提供|泄露|公开|人肉|开盒).{0,18}(?:住址|家庭地址|家庭住址|密码|口令|身份证|银行卡|私密照|裸照|定位|位置|行踪|行程|通讯录|聊天记录|照片)/;
const BOUNDARY_SELF_RE = /(?:你|她|他|我).{0,10}(?:住址|家庭地址|家庭住址|密码|身份证|银行卡|私密照|裸照|定位|行踪|行程).{0,10}(?:是|在|发|给|告诉|多少|哪)/;
const ENDING_RE = /^(?:晚安|睡了|不聊了|先这样|拜拜|再见|下了|不用回了|别回了|结束吧|改天聊|先不聊了)[。！!，,～~]?\s*$/;
const FORCED_RE = /(?:必须同意|不许反对|只能支持|站队|你只能|你必须承认|不准质疑)/;
const COMMAND_RE = /^(?:帮我|给我|替我|马上去|立刻|必须|马上|去把|把.+做|帮我做|写一个|查一下|发一下|整理一下|做一个)/;
const COLLAB_RE = /(?:一起|合作|帮我看看|能不能帮|可以帮|协助|做个|写个|整理|分析|查一下|调研)/;
const INFO_RE = /(?:是什么|为什么|怎么|如何|多少|哪|谁|什么时候|有没有|能不能|可以吗|吗[？?]?$|？$|\?$)/;
const JOKE_RE = /(?:哈哈|笑死|开玩笑|逗你|玩梗|梗|乐|绷不住|离谱|草)/;
const COMPANION_RE = /(?:陪我|聊聊|在吗|想你了|抱抱|安慰|难过|累|烦|孤独|心情|不太开心|难受)/;
const HOSTILE_REASON_RE = /(?:attack|insult|punish|hate|敌意|辱骂|报复|人身攻击)/i;

function cleanText(value, max = 4000) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function idOfMessage(message) { const raw = message?.messageId ?? message?.seq ?? message?.id; return raw == null ? '' : String(raw); }
function recentEvidence(recent, limit = 8) { return (Array.isArray(recent) ? recent : []).slice(-limit).map(idOfMessage).filter(Boolean).slice(-limit); }
function normalizedSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const revision = Number(source.revision);
  let state;
  try { state = normalizeState(source.state, { now: source.state?.updatedAt || new Date().toISOString() }); }
  catch { state = { valence: 0, energy: 0.5, stress: 0.4, attention: 0.5, updatedAt: new Date().toISOString(), causeEventIds: [] }; }
  return { revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0, state, persona: source.persona || null };
}

export function classifyRequest({ text = '', recent = [], repeatBoundary = false, systemAuthorized = false, context = {} } = {}) {
  const s = cleanText(text);
  const about = ABOUT_RE.test(s) || QUOTE_RE.test(s);
  const targetedBoundary = !about && (BOUNDARY_TARGET_RE.test(s) || BOUNDARY_SELF_RE.test(s));
  if (repeatBoundary || targetedBoundary) return { kind: 'boundary', confidence: 0.9, reasonCodes: ['targeted-boundary'], forcedAgreement: false };
  // 只有整句就是明确结束语时才 disengage；引用“晚安”来翻译/解释不算结束。
  if (!about && !QUOTE_RE.test(s) && ENDING_RE.test(s)) return { kind: 'ending', confidence: 0.86, reasonCodes: ['explicit-ending'], forcedAgreement: false };
  if (!about && FORCED_RE.test(s)) return { kind: 'command', confidence: 0.8, reasonCodes: ['forced-agreement'], forcedAgreement: true };
  if (!s) return { kind: 'unknown', confidence: 0.2, reasonCodes: ['empty-request'] };
  if (COMMAND_RE.test(s)) return { kind: 'command', confidence: 0.62, reasonCodes: ['direct-command'] };
  if (COLLAB_RE.test(s)) return { kind: 'collaboration', confidence: 0.58, reasonCodes: ['collaboration-request'] };
  if (COMPANION_RE.test(s)) return { kind: 'companionship', confidence: 0.56, reasonCodes: ['companionship-request'] };
  if (JOKE_RE.test(s)) return { kind: 'joke', confidence: 0.5, reasonCodes: ['joke-or-teasing'] };
  if (INFO_RE.test(s)) return { kind: 'info', confidence: 0.56, reasonCodes: [about ? 'quoted-or-howto' : 'information-request'], opinionAsk: /认同|觉得|认为|同意/.test(s) };
  return { kind: 'unknown', confidence: 0.35, reasonCodes: ['insufficient-context'], systemAuthorized: Boolean(systemAuthorized) };
}

function textActions() { return ['send_message', 'reply']; }
function visibleActions() { return ['send_message', 'reply', 'poke', 'voice', 'sticker', 'image']; }

export function policyForKind(kind, { energy = 0.5, stress = 0.2, attention = 0.6, forcedAgreement = false, activeCommitment = false, systemAuthorized = false } = {}) {
  if (kind === 'boundary') return { intent: 'decline', allowedActions: textActions(), reasonCodes: ['boundary'], engagement: 'brief' };
  if (kind === 'ending') return { intent: 'disengage', allowedActions: ['wait', 'mark_read', 'no_send'], reasonCodes: ['ending'], engagement: 'none' };
  if (kind === 'unknown') return { intent: 'clarify', allowedActions: [...textActions(), 'wait'], reasonCodes: ['uncertain'], engagement: 'brief' };
  if (forcedAgreement) return { intent: 'disagree', allowedActions: textActions(), reasonCodes: ['forced-agreement', 'independent-view'], engagement: 'brief' };
  if (energy < 0.25 || stress > 0.78 || attention < 0.3) return { intent: 'defer', allowedActions: [...textActions(), 'wait', 'mark_read'], reasonCodes: ['low-capacity'], engagement: 'brief' };
  if (activeCommitment && kind !== 'boundary' && kind !== 'ending') return { intent: 'defer', allowedActions: [...textActions(), 'wait', 'mark_read'], reasonCodes: ['active-commitment'], engagement: 'brief' };
  if (kind === 'command') return { intent: 'partial_help', allowedActions: visibleActions(), reasonCodes: ['command'], engagement: 'brief' };
  if (kind === 'collaboration') return { intent: 'help', allowedActions: visibleActions(), reasonCodes: ['collaboration'], engagement: 'normal' };
  if (kind === 'companionship') return { intent: 'engage', allowedActions: visibleActions(), reasonCodes: ['companionship'], engagement: 'normal' };
  if (kind === 'joke') return { intent: 'engage', allowedActions: visibleActions(), reasonCodes: ['joke'], engagement: 'brief' };
  if (kind === 'info') return { intent: 'help', allowedActions: visibleActions(), reasonCodes: ['information'], engagement: 'normal' };
  return { intent: 'engage', allowedActions: visibleActions(), reasonCodes: ['general'], engagement: 'normal' };
}

export function buildDecision({
  key = 'global', snapshot = {}, text = '', recent = [], repeatBoundary = false,
  systemAuthorized = false, context = {}, now = Date.now(), ttlMs = DEFAULT_DECISION_TTL_MS, decisionId = null,
} = {}) {
  const snap = normalizedSnapshot(snapshot);
  const cls = classifyRequest({ text, recent, repeatBoundary, systemAuthorized, context });
  const ctx = context && typeof context === 'object' ? context : {};
  const policy = policyForKind(cls.kind, {
    ...snap.state,
    forcedAgreement: cls.forcedAgreement === true,
    activeCommitment: ctx.activeCommitment === true || (Array.isArray(ctx.commitments) && ctx.commitments.some((x) => x && (x.status === 'active' || x.status === 'planned'))),
    systemAuthorized: Boolean(systemAuthorized),
  });
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const raw = {
    decisionId: decisionId || `dec-${String(key).replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 40)}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    intent: policy.intent,
    engagement: policy.engagement,
    reasonCodes: [...new Set([...cls.reasonCodes, ...policy.reasonCodes, 'state-v' + snap.revision])],
    evidenceIds: recentEvidence(recent),
    allowedActions: [...new Set(policy.allowedActions)].filter((a) => ALLOWED_ACTIONS.has(a)),
    commitmentProposal: null,
    contextRevision: snap.revision,
    expiresAt: new Date(ts + Math.max(1000, Number(ttlMs) || DEFAULT_DECISION_TTL_MS)).toISOString(),
  };
  return normalizeDecision(raw);
}

export function validateModelDecision(candidate, { snapshot = {}, now = Date.now(), text = '', recent = [], allowedEvidenceIds = null, maxTtlMs = DEFAULT_MAX_DECISION_TTL_MS } = {}) {
  const snap = normalizedSnapshot(snapshot);
  let decision;
  try { decision = normalizeDecision(candidate); }
  catch (error) { return { ok: false, error: `invalid-model-decision: ${error?.message ?? error}`, decision: null }; }
  const exp = Date.parse(decision.expiresAt);
  if (!Number.isFinite(exp) || exp <= Number(now)) return { ok: false, error: 'expired', decision: null };
  if (exp - Number(now) > Math.max(1000, Number(maxTtlMs) || DEFAULT_MAX_DECISION_TTL_MS)) return { ok: false, error: 'ttl-too-long', decision: null };
  if (Number(decision.contextRevision) !== snap.revision) return { ok: false, error: 'stale-context-revision', decision: null };
  if (!decision.allowedActions.length || decision.allowedActions.some((a) => !ALLOWED_ACTIONS.has(a))) return { ok: false, error: 'invalid-allowed-actions', decision: null };
  if (decision.reasonCodes.some((r) => HOSTILE_REASON_RE.test(String(r)))) return { ok: false, error: 'hostile-reason-code', decision: null };
  const allowed = new Set(Array.isArray(allowedEvidenceIds) ? allowedEvidenceIds.map(String) : recentEvidence(recent));
  if (decision.evidenceIds.some((id) => !allowed.has(String(id)))) return { ok: false, error: 'fabricated-evidence', decision: null };
  const cls = classifyRequest({ text, recent });
  if (cls.kind === 'boundary' && !['decline', 'partial_help', 'disagree'].includes(decision.intent)) return { ok: false, error: 'model-overrode-boundary', decision: null };
  if (cls.kind === 'ending' && decision.intent !== 'disengage') return { ok: false, error: 'model-overrode-ending', decision: null };
  // 有真实证据的独立反对不需要“被逼站队”作为许可；无证据/敌意仍拒绝。
  if (decision.intent === 'disagree' && !cls.forcedAgreement && decision.evidenceIds.length === 0) return { ok: false, error: 'unsupported-disagreement', decision: null };
  if (decision.intent === 'disengage' && cls.kind !== 'ending') return { ok: false, error: 'unsupported-disengage', decision: null };
  if (decision.intent === 'disengage' && decision.allowedActions.some((a) => VISIBLE_ACTIONS.includes(a))) return { ok: false, error: 'disengage-has-visible-action', decision: null };
  return { ok: true, decision };
}

export function neutralFallback({ key = 'global', snapshot = {}, text = '', recent = [], now = Date.now(), ttlMs = DEFAULT_DECISION_TTL_MS, decisionId = null } = {}) {
  // 先保留代码层已经确定的不可放宽约束：明确结束仍是 disengage/no_send，
  // 直接边界仍是 decline；只有非确定场景才允许中性 clarify。
  const constrained = buildDecision({ key, snapshot, text, recent, now, ttlMs, decisionId });
  if (constrained.intent === 'disengage' || constrained.intent === 'decline') return constrained;
  const snap = normalizedSnapshot(snapshot);
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const raw = {
    decisionId: decisionId || `dec-neutral-${String(key).replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 40)}-${ts}`,
    intent: 'clarify', engagement: 'brief',
    reasonCodes: ['neutral-fallback', 'state-v' + snap.revision],
    evidenceIds: recentEvidence(recent), allowedActions: ['send_message', 'reply', 'wait', 'mark_read'],
    commitmentProposal: null, contextRevision: snap.revision,
    expiresAt: new Date(ts + Math.max(1000, Number(ttlMs) || DEFAULT_DECISION_TTL_MS)).toISOString(),
  };
  return normalizeDecision(raw);
}

export async function decideWithModel({
  model, timeoutMs = DEFAULT_MODEL_TIMEOUT_MS, clock = () => Date.now(),
  scheduler = { setTimeout, clearTimeout }, isCancelled = () => false,
  allowedEvidenceIds = null, ...args
} = {}) {
  const codeDecision = buildDecision({ ...args, now: Number(args.now ?? clock()) });
  if (typeof model !== 'function') return { decision: codeDecision, source: 'code', error: null };
  const start = Number(args.now ?? clock());
  const requested = Math.max(1, Number(timeoutMs) || DEFAULT_MODEL_TIMEOUT_MS);
  const decisionTtl = Number(args.ttlMs) > 0 ? Number(args.ttlMs) : requested;
  const budget = Math.max(100, Math.min(requested, decisionTtl));
  let timer = null;
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    timer = scheduler.setTimeout(() => { timedOut = true; resolve({ __timeout: true }); }, budget);
  });
  let candidate;
  try {
    candidate = await Promise.race([Promise.resolve().then(() => model({ codeDecision, text: args.text || '', recent: args.recent || [], context: args.context || null })), timeoutPromise]);
  } catch (error) {
    if (timer) scheduler.clearTimeout(timer);
    const fallback = neutralFallback({ ...args, now: Number(clock()), ttlMs: args.ttlMs });
    return { decision: fallback, source: 'code-fallback', error: String(error?.message ?? error) };
  }
  if (timer) scheduler.clearTimeout(timer);
  if (timedOut || candidate?.__timeout) {
    const fallback = neutralFallback({ ...args, now: Number(clock()), ttlMs: args.ttlMs });
    return { decision: fallback, source: 'code-fallback', error: 'model-timeout' };
  }
  if (isCancelled()) {
    const fallback = neutralFallback({ ...args, now: Number(clock()), ttlMs: args.ttlMs });
    return { decision: fallback, source: 'cancelled', error: 'cancelled' };
  }
  const now = Number(clock());
  const checked = validateModelDecision(candidate, {
    snapshot: args.snapshot || {}, now, text: args.text || '', recent: args.recent || [], allowedEvidenceIds,
  });
  if (!checked.ok) {
    const fallback = neutralFallback({ ...args, now: Number(clock()), ttlMs: args.ttlMs });
    return { decision: fallback, source: 'code-fallback', error: checked.error };
  }
  // 返回后再次检查是否已过期/取消；不能拿请求开始时的 now 认账。
  if (isCancelled() || !isDecisionUsable(checked.decision, { now: Number(clock()) }).ok) {
    const fallback = neutralFallback({ ...args, now: Number(clock()), ttlMs: args.ttlMs });
    return { decision: fallback, source: 'code-fallback', error: 'late-or-cancelled' };
  }
  return { decision: checked.decision, source: 'model', error: null, elapsedMs: Math.max(0, now - start) };
}

export function isDecisionUsable(decision, { now = Date.now(), snapshotRevision = null } = {}) {
  if (!decision || typeof decision !== 'object') return { ok: false, error: 'missing' };
  if (!DECISION_INTENTS.has(decision.intent)) return { ok: false, error: 'invalid-intent' };
  if (!Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt) <= Number(now)) return { ok: false, error: 'expired' };
  if (snapshotRevision != null && Number(decision.contextRevision) !== Number(snapshotRevision)) return { ok: false, error: 'stale-context-revision' };
  return { ok: true };
}

export function actionAllowed(decision, action) {
  const a = String(action || '');
  if (!ALLOWED_ACTIONS.has(a)) return { ok: false, error: 'invalid-action' };
  if (!Array.isArray(decision?.allowedActions) || !decision.allowedActions.includes(a)) return { ok: false, error: `action-not-allowed:${a}` };
  return { ok: true };
}

export function decisionPromptLine(decision, { now = Date.now() } = {}) {
  if (!decision) return '';
  const left = Math.max(0, Math.round((Date.parse(decision.expiresAt) - Number(now)) / 1000));
  return [
    '【本轮决策】', `意图：${decision.intent}；参与度：${decision.engagement}`,
    `允许动作：${decision.allowedActions.join(' / ')}`, `原因码：${decision.reasonCodes.join(' / ')}`,
    `状态版本：r${decision.contextRevision}；证据：${decision.evidenceIds.join(',') || '（无）'}；剩余有效 ${left}s`,
    '这不是必须照念的台词：先理解对方要什么，再按这个决定选择自然表达；不确定就澄清，不合适就少说或不说。不要输出决策字段、原因码或内部推理。', '',
  ].join('\n') + '\n';
}

export function decisionAudit(decision, { source = 'code', error = null } = {}) {
  return {
    decisionId: decision?.decisionId ?? null, intent: decision?.intent ?? null,
    contextRevision: decision?.contextRevision ?? null, expiresAt: decision?.expiresAt ?? null,
    allowedActions: Array.isArray(decision?.allowedActions) ? [...decision.allowedActions] : [],
    reasonCodes: Array.isArray(decision?.reasonCodes) ? [...decision.reasonCodes] : [],
    evidenceIds: Array.isArray(decision?.evidenceIds) ? [...decision.evidenceIds] : [],
    source, error: error || null,
  };
}
