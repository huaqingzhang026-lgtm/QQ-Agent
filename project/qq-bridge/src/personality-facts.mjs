// A04 统一事实身份：跨入站、affinity、决策 outcome 共用一个规范。
// 只依赖 node:crypto；调用方传入 scope/actor/messageId。
import crypto from 'node:crypto';

export const FACT_SCHEMA_VERSION = 1;

export function canonicalFactKey({ scope, actorId, messageId } = {}) {
  const s = String(scope ?? '').trim();
  const a = String(actorId ?? '').trim();
  const m = String(messageId ?? '').trim();
  if (!s || !a || !m) return null;
  return `fact:v1:${encodeURIComponent(s)}:${encodeURIComponent(a)}:${encodeURIComponent(m)}`;
}

/** 旧入站明文键（A04-rework2 之前）。 */
export function legacyPlainFactKey({ scope, actorId, messageId } = {}) {
  if (!scope || !actorId || !messageId) return null;
  return `fact:${String(scope)}|${String(actorId)}|${String(messageId)}`;
}

/** 旧 affinity 哈希键：完整证据集合；同时返回截断 24 位兼容旧写入。 */
export function legacyHashedFactKeys({ scope, actorId, evidenceRefs = [] } = {}) {
  if (!scope || !actorId) return [];
  const refs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : []).map(String).filter(Boolean))].sort();
  if (!refs.length) return [];
  const raw = `${String(scope)}|${String(actorId)}|${refs.join(',')}`;
  const full = crypto.createHash('sha1').update(raw).digest('hex');
  return [`fact:${full}`, `fact:${full.slice(0, 24)}`];
}

/**
 * 从事件读取内部 coreFact 契约。只有 scope/actor 与事件一致、且 messageId 在 evidenceRefs
 * 中时才接受；不直接信任任意 payload.coreFactKey 字符串。
 */
export function coreFactFromEvent(event) {
  const p = event?.payload?.coreFact;
  if (!p || typeof p !== 'object') return null;
  const scope = String(p.scope ?? '');
  const actorId = String(p.actorId ?? '');
  const messageId = String(p.messageId ?? '');
  if (!scope || !actorId || !messageId) return null;
  if (scope !== String(event.scope ?? '') || actorId !== String(event.actorId ?? '')) return null;
  const refs = (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []).map(String);
  if (!refs.includes(messageId)) return null;
  return { scope, actorId, messageId };
}
