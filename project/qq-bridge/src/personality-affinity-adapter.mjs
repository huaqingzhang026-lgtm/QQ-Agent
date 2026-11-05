// A04 affinity 兼容适配器（纯逻辑 + 受控文件）。
//
// 旧 affinity MCP 的 bump 不能直接改 SQLite 里的 trust/closeness/tension；
// 这里只做三件事：
//   1. 读 bridge 写出的只读投影（指标/分层，无消息文本、无 notes、无 evidence）；
//   2. 有事件证据的 bump → 写候选请求，交给 bridge 在本会话校验后应用；
//   3. 无证据的 bump/note/set → 只写“待核实”，不产生关系变化。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { effectFor } from './personality-affect.mjs';
import { canonicalFactKey } from './personality-facts.mjs';

export const AFFINITY_SCHEMA_VERSION = 1;
export const MAX_OBSERVATION_DELTA = 0.03;
const MAX_QUEUE = 100;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function projectionFile(root) {
  return path.join(root, 'qq-bridge', 'state', 'affinity-projection.json');
}
export function requestFile(root) {
  return path.join(root, 'qq-bridge', 'state', 'affinity-requests.json');
}
export function pendingFile(root) {
  return path.join(root, 'qq-bridge', 'state', 'affinity-pending.json');
}

export function readProjection(root) {
  const data = readJson(projectionFile(root), {}) || {};
  return {
    version: Number(data.version) || 0,
    updatedAt: data.updatedAt || null,
    people: data.people && typeof data.people === 'object' ? data.people : {},
  };
}

/** 只输出维度/分层；绝不输出 notes、消息文本或 evidence IDs。 */
export function describeRelationship(projection, uin) {
  const rel = projection?.people?.[String(uin)];
  if (!rel) return `${uin}：还没有可用的关系记录（默认按陌生人处理）。`;
  const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
  return [
    `${uin}：${rel.tier || '陌生人'}`,
    `信任 ${pct(rel.trust)} / 亲近 ${pct(rel.closeness)} / 紧张 ${pct(rel.tension)} / 熟悉 ${pct(rel.familiarity)}`,
    '这是长期趋势，不是本轮语气指令；边界与判断仍按当前语境。',
  ].join('\n');
}

export function normalizeBumpRequest({ uin, key, delta = 0, reason = '', evidenceIds = [], targetId = '', factType = '', verified = false } = {}) {
  const actorId = String(uin ?? '').trim();
  if (!/^\d{2,20}$/.test(actorId)) return { ok: false, code: 'invalid-uin' };
  const scope = String(key ?? '').trim();
  if (!/^(group|private):\d+$/.test(scope)) return { ok: false, code: 'invalid-key' };
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return { ok: false, code: 'invalid-delta' };
  const ids = (Array.isArray(evidenceIds) ? evidenceIds : []).map(String).map((x) => x.trim()).filter(Boolean).slice(0, 5);
  if (!ids.length) return { ok: false, code: 'evidence-required' };
  if (ids.some((x) => x.length > 128)) return { ok: false, code: 'invalid-evidence' };
  const bounded = Math.max(-MAX_OBSERVATION_DELTA, Math.min(MAX_OBSERVATION_DELTA, n));
  return {
    ok: true,
    request: {
      id: `aff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      uin: actorId,
      key: scope,
      delta: Math.round(bounded * 1e6) / 1e6,
      reason: cleanText(reason, 120),
      evidenceIds: ids,
      targetId: /^\d{2,20}$/.test(String(targetId ?? '').trim()) ? String(targetId).trim() : '',
      factType: cleanText(factType, 48),
      verified: verified === true,
      at: Date.now(),
    },
  };
}

/** 有证据：写候选请求；bridge 消费时才写 canonical event。 */
export function enqueueBumpRequest(root, request) {
  const file = requestFile(root);
  const list = readJson(file, []);
  const queue = Array.isArray(list) ? list : [];
  queue.push(request);
  while (queue.length > MAX_QUEUE) queue.shift();
  writeJsonAtomic(file, queue);
  return { ok: true, queued: true, count: queue.length };
}

/** 无证据/直接 set：只记待核实，不改任何关系维度。 */
export function recordPendingObservation(root, { uin, key = '', delta = 0, reason = '', evidenceIds = [], kind = 'unverified' } = {}) {
  const file = pendingFile(root);
  const list = readJson(file, []);
  const queue = Array.isArray(list) ? list : [];
  queue.push({
    id: `aff-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    uin: String(uin ?? '').slice(0, 32),
    key: /^(group|private):\d+$/.test(String(key ?? '')) ? String(key) : '',
    delta: Number.isFinite(Number(delta)) ? Number(delta) : 0,
    reason: cleanText(reason, 120),
    evidenceIds: (Array.isArray(evidenceIds) ? evidenceIds : []).map(String).slice(0, 5),
    kind,
    status: 'unverified',
    at: Date.now(),
  });
  while (queue.length > MAX_QUEUE) queue.shift();
  writeJsonAtomic(file, queue);
  return { ok: true, pending: true, count: queue.length };
}

/**
 * 把通过本会话证据校验的请求转成 canonical observation 事件。
 * delta 很小，且只影响 trust/closeness/tension，不直接写关系表。
 */
export function observationEventFor({ request, actorId, scope, evidenceRefs, coreRefs = null, kind, confidence = 0.6 } = {}) {
  const allRefs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : []).map(String).filter(Boolean))].sort();
  const refs = [...new Set((Array.isArray(coreRefs) ? coreRefs : allRefs).map(String).filter(Boolean))].sort();
  // 事实身份来自 coreRefs；与入站/决策使用同一个 canonicalFactKey 规范。
  const coreMessageId = refs[0] || '';
  const factKey = canonicalFactKey({ scope, actorId, messageId: coreMessageId });
  const factHash = crypto.createHash('sha1').update(`${scope}|${actorId}|${refs.join(',')}`).digest('hex').slice(0, 24);
  const coreFact = { scope: String(scope), actorId: String(actorId), messageId: String(coreMessageId) };
  const explicitKind = kind !== undefined;
  const eventKind = kind === undefined ? 'relationship.observation' : kind;
  let effect = effectFor(eventKind) || { stateDelta: null, relationshipDelta: null };
  if (!explicitKind) {
    // 兼容 A04 旧直接调用：仍保留有界 observation 效果；bridge 真实路径始终显式传 kind，
    // 不会把随机 request.id/model delta 当成新的关系事实。
    const delta = Math.max(-MAX_OBSERVATION_DELTA, Math.min(MAX_OBSERVATION_DELTA, Number(request?.delta) || 0));
    const magnitude = Math.abs(delta);
    effect = {
      stateDelta: null,
      relationshipDelta: delta >= 0
        ? { trust: magnitude, closeness: Math.round(magnitude * 0.5 * 1e6) / 1e6 }
        : { trust: -magnitude, tension: Math.round(magnitude * 0.5 * 1e6) / 1e6 },
    };
  }
  return {
    eventId: `evt:${scope}:${actorId}:aff:${factHash}`,
    source: 'affinity-mcp',
    scope: String(scope),
    actorId: String(actorId),
    kind: String(eventKind),
    occurredAt: new Date(Number(request?.at) || Date.now()).toISOString(),
    recordedAt: new Date().toISOString(),
    reality: 'inferred',
    status: 'completed',
    evidenceRefs: refs.slice(0, 5),
    confidence: Math.max(0.5, Math.min(0.95, Number(confidence) || effect.confidence || 0.6)),
    payload: { conversationKey: String(scope), reason: cleanText(request?.reason, 80), factKey, coreFact, coreFactKey: factKey, sourceFactType: cleanText(request?.factType, 48), sourceVerified: request?.verified === true },
    stateDelta: effect.stateDelta,
    relationshipDelta: effect.relationshipDelta,
  };
}

