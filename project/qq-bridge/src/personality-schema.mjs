// A02 人格状态 schema：稳定人格、当前状态、事件、决策结果的版本化校验。
//
// 边界：本模块是纯函数，不读写文件、不连数据库、不调用网络/模型。
// 外部消息、模型输出、旧 JSON 都只是数据；不能通过其中字段改变 schema 或人格版本。

export const PERSONALITY_SCHEMA_VERSION = 1;
export const DEFAULT_SCOPE = 'global';
export const PERSONA_VERSION = 'p-0001';

export const REALITY = new Set(['observed', 'reported', 'simulated', 'inferred']);
export const EVENT_STATUS = new Set(['planned', 'active', 'completed', 'cancelled', 'uncertain']);
export const DECISION_INTENTS = new Set([
  'engage', 'clarify', 'help', 'partial_help', 'decline', 'defer', 'disagree', 'share', 'repair', 'disengage',
]);
export const STATE_FIELDS = ['valence', 'energy', 'stress', 'attention'];
export const STATE_LIMITS = { valence: [-1, 1], energy: [0, 1], stress: [0, 1], attention: [0, 1] };
export const MAX_STATE_STEP = 0.25;

// A04：人物关系是独立于“本轮情绪”的长期维度。信任/亲近/紧张/熟悉都在 [0,1]，
// 单事件变化有上限；普通聊天只能增加有界的 familiarity，不能自动涨 trust。
export const RELATIONSHIP_FIELDS = ['trust', 'closeness', 'tension', 'familiarity'];
export const RELATIONSHIP_LIMITS = { trust: [0, 1], closeness: [0, 1], tension: [0, 1], familiarity: [0, 1] };
export const MAX_RELATIONSHIP_STEP = 0.12;

// 从既有性格提取的“可调整初始设定”，不是从零替换人格，也不含伪装/依赖要求。
export const DEFAULT_PERSONA = {
  schemaVersion: PERSONALITY_SCHEMA_VERSION,
  personaVersion: PERSONA_VERSION,
  identity: { kind: 'virtual', fictionMode: 'explicit' },
  values: [
    { id: 'autonomy', description: '愿意帮忙，但不接受关系绑架；可以拒绝、暂缓或提出替代方案' },
    { id: 'honesty', description: '不知道就承认，不把生成故事当实际经历，不假装完成未完成的事' },
    { id: 'care', description: '在意具体的人，但关心不等于无限顺从或放弃边界' },
  ],
  preferences: [],
  boundaries: [
    { id: 'privacy', description: '不泄露主人/他人的隐私，不把私聊内容带进群聊' },
    { id: 'no_fabrication', description: '不声称做过实际没做的事；模拟内容标为模拟' },
  ],
  style: { tone: 'natural', length: 'adaptive' },
  changeEvidenceIds: [],
};

function round6(n) { return Math.round(n * 1e6) / 1e6; }

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SCOPE_RE = /^(global|group:\d+|private:\d+|person:[A-Za-z0-9_-]{1,128})$/;

export function isIsoTime(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function isScope(value) {
  return typeof value === 'string' && SCOPE_RE.test(value);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function arr(value) {
  return Array.isArray(value);
}

function stringArray(value, maxItems = 64, maxLen = 256) {
  return Array.isArray(value) && value.length <= maxItems && value.every((x) => typeof x === 'string' && x.length <= maxLen);
}

function finiteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function sanitizeId(value, max = 128) {
  return str(value, max) && !/[\u0000-\u001F\u007F]/.test(value);
}

export function normalizePersona(input) {
  if (!isPlainObject(input)) throw new Error('persona 必须是对象');
  if (input.schemaVersion !== PERSONALITY_SCHEMA_VERSION) throw new Error(`persona.schemaVersion 必须是 ${PERSONALITY_SCHEMA_VERSION}`);
  if (!sanitizeId(input.personaVersion, 64)) throw new Error('personaVersion 缺失或非法');
  if (!isPlainObject(input.identity) || input.identity.kind !== 'virtual' || input.identity.fictionMode !== 'explicit') {
    throw new Error('identity 必须是 virtual/explicit');
  }
  if (!Array.isArray(input.values) || !input.values.every((v) => sanitizeId(v?.id, 64) && typeof v?.description === 'string')) {
    throw new Error('values 必须是 {id,description} 数组');
  }
  if (!Array.isArray(input.preferences)) throw new Error('preferences 必须是数组');
  if (!Array.isArray(input.boundaries) || !input.boundaries.every((v) => sanitizeId(v?.id, 64) && typeof v?.description === 'string')) {
    throw new Error('boundaries 必须是 {id,description} 数组');
  }
  if (!isPlainObject(input.style)) throw new Error('style 必须是对象');
  if (!stringArray(input.changeEvidenceIds)) throw new Error('changeEvidenceIds 必须是字符串数组');
  return {
    schemaVersion: PERSONALITY_SCHEMA_VERSION,
    personaVersion: input.personaVersion,
    identity: { kind: 'virtual', fictionMode: 'explicit' },
    values: input.values.map((v) => ({ id: v.id, description: v.description })),
    preferences: input.preferences.map((v) => (typeof v === 'string' ? v : String(v?.id ?? v))).slice(0, 64),
    boundaries: input.boundaries.map((v) => ({ id: v.id, description: v.description })),
    style: { ...input.style },
    changeEvidenceIds: [...input.changeEvidenceIds],
  };
}

export function initialState(now = new Date().toISOString()) {
  if (!isIsoTime(now)) throw new Error('now 必须是 ISO 时间');
  return {
    valence: 0,
    energy: 0.6,
    stress: 0.2,
    attention: 0.7,
    updatedAt: now,
    causeEventIds: [],
  };
}

export function normalizeState(input, { now = new Date().toISOString() } = {}) {
  const source = isPlainObject(input) ? input : initialState(now);
  const out = { ...initialState(now), ...source };
  for (const key of STATE_FIELDS) {
    const [min, max] = STATE_LIMITS[key];
    if (!finiteInRange(out[key], min, max)) throw new Error(`state.${key} 超出范围`);
  }
  if (!isIsoTime(out.updatedAt)) throw new Error('state.updatedAt 非法');
  if (!stringArray(out.causeEventIds, 20, 128)) throw new Error('state.causeEventIds 非法');
  return {
    valence: round6(out.valence),
    energy: round6(out.energy),
    stress: round6(out.stress),
    attention: round6(out.attention),
    updatedAt: out.updatedAt,
    causeEventIds: [...out.causeEventIds].slice(-20),
  };
}

export function normalizeStateDelta(input) {
  if (input == null) return null;
  if (!isPlainObject(input)) throw new Error('stateDelta 必须是对象');
  const out = {};
  for (const key of STATE_FIELDS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error(`stateDelta.${key} 必须是有限数值`);
    if (Math.abs(input[key]) > MAX_STATE_STEP) throw new Error(`stateDelta.${key} 单事件变化超过 ${MAX_STATE_STEP}`);
    out[key] = input[key];
  }
  return Object.keys(out).length ? out : null;
}

export function applyStateDelta(state, delta, { now = new Date().toISOString(), eventId = null } = {}) {
  const base = normalizeState(state, { now });
  if (!delta) return base;
  const next = { ...base };
  for (const key of STATE_FIELDS) {
    if (delta[key] === undefined) continue;
    const [min, max] = STATE_LIMITS[key];
    next[key] = round6(Math.max(min, Math.min(max, next[key] + delta[key])));
  }
  next.updatedAt = now;
  if (eventId) next.causeEventIds = [...next.causeEventIds, String(eventId)].slice(-20);
  return normalizeState(next, { now });
}

/** A04 关系初始值：陌生人，不是朋友；familiarity 从 0 开始。 */
export function initialRelationship(now = new Date().toISOString()) {
  if (!isIsoTime(now)) throw new Error('now 必须是 ISO 时间');
  return {
    trust: 0.25,
    closeness: 0.1,
    tension: 0,
    familiarity: 0,
    updatedAt: now,
    causeEventIds: [],
  };
}

export function normalizeRelationship(input, { now = new Date().toISOString() } = {}) {
  const source = isPlainObject(input) ? input : initialRelationship(now);
  const out = { ...initialRelationship(now), ...source };
  for (const key of RELATIONSHIP_FIELDS) {
    const [min, max] = RELATIONSHIP_LIMITS[key];
    if (!finiteInRange(out[key], min, max)) throw new Error(`relationship.${key} 超出范围`);
  }
  if (!isIsoTime(out.updatedAt)) throw new Error('relationship.updatedAt 非法');
  if (!stringArray(out.causeEventIds, 20, 128)) throw new Error('relationship.causeEventIds 非法');
  return {
    trust: round6(out.trust),
    closeness: round6(out.closeness),
    tension: round6(out.tension),
    familiarity: round6(out.familiarity),
    updatedAt: out.updatedAt,
    causeEventIds: [...out.causeEventIds].slice(-20),
  };
}

export function normalizeRelationshipDelta(input) {
  if (input == null) return null;
  if (!isPlainObject(input)) throw new Error('relationshipDelta 必须是对象');
  const out = {};
  for (const key of RELATIONSHIP_FIELDS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error(`relationshipDelta.${key} 必须是有限数值`);
    if (Math.abs(input[key]) > MAX_RELATIONSHIP_STEP) throw new Error(`relationshipDelta.${key} 单事件变化超过 ${MAX_RELATIONSHIP_STEP}`);
    out[key] = input[key];
  }
  return Object.keys(out).length ? out : null;
}

export function applyRelationshipDelta(relationship, delta, { now = new Date().toISOString(), eventId = null } = {}) {
  const base = normalizeRelationship(relationship, { now });
  if (!delta) return base;
  const next = { ...base };
  for (const key of RELATIONSHIP_FIELDS) {
    if (delta[key] === undefined) continue;
    const [min, max] = RELATIONSHIP_LIMITS[key];
    next[key] = round6(Math.max(min, Math.min(max, next[key] + delta[key])));
  }
  next.updatedAt = now;
  if (eventId) next.causeEventIds = [...next.causeEventIds, String(eventId)].slice(-20);
  return normalizeRelationship(next, { now });
}

export function normalizeEvent(input) {
  if (!isPlainObject(input)) throw new Error('event 必须是对象');
  if (!sanitizeId(input.eventId)) throw new Error('eventId 缺失或非法');
  if (!str(input.source, 64)) throw new Error('source 缺失或非法');
  if (!isScope(input.scope)) throw new Error('scope 非法');
  if (!sanitizeId(input.actorId)) throw new Error('actorId 缺失或非法');
  if (!str(input.kind, 64)) throw new Error('kind 缺失或非法');
  if (!REALITY.has(input.reality)) throw new Error('reality 非法');
  if (!EVENT_STATUS.has(input.status)) throw new Error('status 非法');
  if (!isIsoTime(input.recordedAt)) throw new Error('recordedAt 非法');
  if (input.occurredAt != null && !isIsoTime(input.occurredAt)) throw new Error('occurredAt 非法');
  if (input.scheduledAt != null && !isIsoTime(input.scheduledAt)) throw new Error('scheduledAt 非法');
  if (input.status === 'planned' && !input.occurredAt && !input.scheduledAt) throw new Error('planned 事件需要 occurredAt 或 scheduledAt');
  if (!finiteInRange(input.confidence, 0, 1)) throw new Error('confidence 必须在 [0,1]');
  if (!stringArray(input.evidenceRefs, 64, 512)) throw new Error('evidenceRefs 非法');
  if (input.payload != null && !isPlainObject(input.payload)) throw new Error('payload 必须是对象');
  const stateDelta = normalizeStateDelta(input.stateDelta);
  const relationshipDelta = normalizeRelationshipDelta(input.relationshipDelta);
  return {
    eventId: input.eventId,
    source: input.source,
    scope: input.scope,
    actorId: input.actorId,
    kind: input.kind,
    occurredAt: input.occurredAt ?? null,
    scheduledAt: input.scheduledAt ?? null,
    recordedAt: input.recordedAt,
    reality: input.reality,
    status: input.status,
    evidenceRefs: [...input.evidenceRefs],
    confidence: input.confidence,
    payload: input.payload ? { ...input.payload } : {},
    stateDelta,
    relationshipDelta,
  };
}

export function normalizeDecision(input) {
  if (!isPlainObject(input)) throw new Error('decision 必须是对象');
  if (!sanitizeId(input.decisionId)) throw new Error('decisionId 缺失或非法');
  if (!DECISION_INTENTS.has(input.intent)) throw new Error('intent 非法');
  if (!str(input.engagement, 32)) throw new Error('engagement 非法');
  if (!stringArray(input.reasonCodes, 32, 128)) throw new Error('reasonCodes 非法');
  if (!stringArray(input.evidenceIds, 64, 128)) throw new Error('evidenceIds 非法');
  if (!stringArray(input.allowedActions, 32, 64)) throw new Error('allowedActions 非法');
  if (input.commitmentProposal != null && !isPlainObject(input.commitmentProposal) && !Array.isArray(input.commitmentProposal)) throw new Error('commitmentProposal 必须是对象、数组或 null');
  if (input.commitmentCompletion != null && !isPlainObject(input.commitmentCompletion) && !Array.isArray(input.commitmentCompletion)) throw new Error('commitmentCompletion 必须是对象、数组或 null');
  if (!Number.isSafeInteger(input.contextRevision) || input.contextRevision < 0) throw new Error('contextRevision 非法');
  if (!isIsoTime(input.expiresAt)) throw new Error('expiresAt 非法');
  return {
    decisionId: input.decisionId,
    intent: input.intent,
    engagement: input.engagement,
    reasonCodes: [...input.reasonCodes],
    evidenceIds: [...input.evidenceIds],
    allowedActions: [...input.allowedActions],
    commitmentProposal: input.commitmentProposal
      ? (Array.isArray(input.commitmentProposal) ? input.commitmentProposal.map((x) => ({ ...x })) : { ...input.commitmentProposal })
      : null,
    commitmentCompletion: input.commitmentCompletion
      ? (Array.isArray(input.commitmentCompletion) ? input.commitmentCompletion.map((x) => ({ ...x })) : { ...input.commitmentCompletion })
      : null,
    contextRevision: input.contextRevision,
    expiresAt: input.expiresAt,
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function snapshotHash(snapshot) {
  // 不依赖 crypto，调用方可用它做跨重启一致性比较；需要 SHA 时再对 canonicalJson 求哈希。
  return canonicalJson(snapshot);
}

export function planLegacyMigration(legacy = {}) {
  const actions = [];
  const warnings = [];
  let persona = null;
  let state = null;
  if (legacy.persona != null) {
    try { persona = normalizePersona(legacy.persona); actions.push({ op: 'persona.keep', personaVersion: persona.personaVersion }); }
    catch (error) { warnings.push({ field: 'persona', message: String(error.message ?? error), action: 'manual_review' }); }
  } else {
    actions.push({ op: 'persona.seed', personaVersion: PERSONA_VERSION, note: '使用 A02 默认可调整初始人格' });
  }
  if (legacy.state != null) {
    try {
      state = normalizeState(legacy.state, { now: legacy.now ?? new Date().toISOString() });
      actions.push({ op: 'state.keep', fields: STATE_FIELDS });
    } catch (error) {
      warnings.push({ field: 'state', message: String(error.message ?? error), action: 'manual_review' });
    }
  } else {
    actions.push({ op: 'state.seed', fields: STATE_FIELDS });
  }
  if (legacy.affinity != null) {
    actions.push({ op: 'legacy.affinity.readonly', note: '旧好感分只保留兼容显示，不映射为 trust/closeness/tension' });
  }
  return {
    ok: warnings.length === 0,
    applied: false,
    writes: 0,
    persona,
    state,
    actions,
    warnings,
  };
}
