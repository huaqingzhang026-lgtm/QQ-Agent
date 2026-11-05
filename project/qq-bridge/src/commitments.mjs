// A05-rework2 承诺与未决事项：显式状态机 + 完成条件协议 + 可验证证据。
//
// 状态机：
//   proposed --send receipt(success=true)--> active
//   proposed/active --tool receipt(success=true)--> fulfilled
//   proposed/active/uncertain --withdraw--> withdrawn
//   proposed/active/uncertain --due passed--> expired
//   proposed/active --transport unknown--> uncertain
//   uncertain --send receipt(success=true)--> active
//
// 证据不是任意字符串：
//   · 激活必须 kind=send、success=true、messageId/transportRef/executionId 可核对。
//   · 完成必须 kind=tool、success=true、scope/target/action/resultRef 与持久化完成条件全部核对。
//   · 本轮支持的完成类型只有 deliver_message；未知类型保守不结案。
//   · fulfilled/withdrawn/expired 是终态；重复回执幂等，不改成另一个终态。
import { openMemory } from './memory-store.mjs';
import crypto from 'node:crypto';

export const COMMITMENT_STATUSES = Object.freeze([
  'proposed', 'active', 'fulfilled', 'withdrawn', 'expired', 'uncertain',
]);
const TERMINAL_STATUSES = new Set(['fulfilled', 'withdrawn', 'expired']);
export const SUPPORTED_COMPLETION_TYPES = Object.freeze(['deliver_message']);
const COMPLETION_ACTIONS = new Set(['send_message', 'reply']);

function now() { return Date.now(); }
function cleanText(v, max = 300) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanId(v) { return String(v ?? '').trim(); }

function normalizeScopeList(scopes) {
  return (Array.isArray(scopes) ? scopes : []).map(String).filter(Boolean);
}

function sha(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

function safeJson(v) {
  try { return JSON.stringify(v ?? []); } catch { return '[]'; }
}

function parseEvidence(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

/** 兼容旧字符串证据；新写入使用结构化对象。 */
export function commitmentDedupeKey({
  scope, actorId = null, targetId = null, text = '', dueAt = null,
  requestRef = null, requestMessageId = null,
} = {}) {
  const parts = [
    cleanText(scope, 128), cleanId(actorId) || 'self', cleanId(targetId) || '',
    cleanText(text, 300).toLowerCase(), Number(dueAt) || 0,
    cleanId(requestRef), cleanId(requestMessageId),
  ];
  if (!parts[0] || !parts[3]) return null;
  return `cmt-identity-v1:${sha(parts.join('|'))}`;
}

function evidenceRef(value) {
  if (!value || typeof value !== 'object') return String(value ?? '');
  return String(value.ref ?? value.resultRef ?? value.transportRef ?? '');
}

function dedupeEvidence(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const ref = evidenceRef(item);
    const key = ref || JSON.stringify(item ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function visibleRefs(row) {
  const raw = parseEvidence(row?.evidence_json);
  return new Set(raw.map(evidenceRef).filter(Boolean));
}

/**
 * 提出承诺。identity 涵盖 scope/actor/target/text/dueAt/requestRef/requestMessageId/decisionId，
 * 同一决策或同一请求重试只落一条；不同对象、不同请求、不同到期时间不会合并。
 */
export function proposeCommitment({
  id = null, scope, actorId = 'self', targetId = null, text = '', messageText = null,
  dueAt = null, source = 'decision', sourceRef = null, decisionId = null,
  requestRef = null, requestMessageId = null, executionId = null, evidence = [], createdAt = now(),
  completionType = 'unspecified', completionCondition = null,
} = {}) {
  const s = cleanText(scope, 128);
  const t = cleanText(text, 300);
  const mt = cleanText(messageText ?? text, 600);
  const reqRef = cleanId(requestRef);
  const reqMsg = cleanId(requestMessageId);
  const decId = cleanId(decisionId);
  if (!s || !t) return { ok: false, code: 'invalid-scope-or-text' };
  if (!reqRef || !reqMsg) return { ok: false, code: 'request-evidence-required' };
  if (!decId) return { ok: false, code: 'decision-id-required' };
  const reqEvidence = {
    kind: 'request', ref: reqRef, messageId: reqMsg, success: true,
    actorId: cleanId(targetId) || null, targetId: cleanId(targetId) || null, at: Number(createdAt) || now(),
  };
  const identity = commitmentDedupeKey({ scope: s, actorId, targetId, text: t, dueAt, requestRef: reqRef, requestMessageId: reqMsg, decisionId: decId });
  const d = openMemory();
  const existing = d.prepare('SELECT * FROM commitments WHERE identity = ?').get(identity);
  if (existing) {
    return { ok: true, applied: false, duplicate: true, commitment: existing, identity };
  }
  const cid = cleanId(id) || `cmt-${Number(createdAt || now()).toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const record = {
    id: cid,
    scope: s,
    actor_id: cleanId(actorId) || 'self',
    target_id: cleanId(targetId) || null,
    text: t,
    status: 'proposed',
    source: cleanText(source, 64) || 'decision',
    evidence_json: safeJson(dedupeEvidence([...evidence, reqEvidence])),
    created_at: Number(createdAt) || now(),
    activated_at: null,
    completed_at: null,
    due_at: Number(dueAt) || null,
    updated_at: now(),
    reason: null,
    source_ref: sourceRef == null ? null : String(sourceRef),
    identity,
    request_ref: reqRef,
    request_message_id: reqMsg,
    decision_id: decId,
    execution_id: cleanId(executionId) || null,
    message_text: mt || null,
    send_ref: null,
    fulfillment_ref: null,
    fulfillment_tool: null,
    fulfillment_action: null,
    completion_type: cleanId(completionType) || 'unspecified',
    completion_condition_json: safeJson(completionCondition && typeof completionCondition === 'object' ? completionCondition : null),
  };
  try {
    d.prepare(`INSERT INTO commitments
      (id,scope,actor_id,target_id,text,status,source,evidence_json,created_at,activated_at,completed_at,due_at,updated_at,reason,source_ref,
       identity,request_ref,request_message_id,decision_id,execution_id,message_text,send_ref,fulfillment_ref,fulfillment_tool,fulfillment_action,completion_type,completion_condition_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.scope, record.actor_id, record.target_id, record.text, record.status, record.source,
        record.evidence_json, record.created_at, record.activated_at, record.completed_at, record.due_at,
        record.updated_at, record.reason, record.source_ref, record.identity, record.request_ref,
        record.request_message_id, record.decision_id, record.execution_id, record.message_text,
        record.send_ref, record.fulfillment_ref, record.fulfillment_tool, record.fulfillment_action,
        record.completion_type, record.completion_condition_json);
  } catch (error) {
    const again = d.prepare('SELECT * FROM commitments WHERE identity = ?').get(identity);
    if (again) return { ok: true, applied: false, duplicate: true, commitment: again, identity };
    return { ok: false, code: 'commitment-persist-failed', error: error?.message ?? String(error) };
  }
  return { ok: true, applied: true, duplicate: false, commitment: record, identity };
}

function applyTransition(row, nextStatus, patch = {}, at = now()) {
  const d = openMemory();
  const assignments = [
    'status=?', 'updated_at=?',
    ...Object.keys(patch).map((k) => `${k}=?`),
  ];
  const args = [nextStatus, Number(at) || now(), ...Object.values(patch), row.id, row.status];
  const result = d.prepare(`UPDATE commitments SET ${assignments.join(', ')} WHERE id=? AND status=?`)
    .run(...args);
  if (result.changes !== 1) return { row: d.prepare('SELECT * FROM commitments WHERE id=?').get(row.id), changes: 0 };
  return { row: d.prepare('SELECT * FROM commitments WHERE id=?').get(row.id), changes: 1 };
}

function transition(row, nextStatus, patch = {}, at = now()) {
  return applyTransition(row, nextStatus, patch, at).row;
}

/**
 * 发送回执激活。必须由 bridge 在 onebotSend 成功后调用；不接受时间戳字符串或子串匹配。
 */
export function activateCommitment({ id, evidence = null, activatedAt = now() } = {}) {
  const d = openMemory();
  const cid = cleanId(id);
  if (!cid) return { ok: false, code: 'id-required' };
  const row = d.prepare('SELECT * FROM commitments WHERE id=?').get(cid);
  if (!row) return { ok: false, code: 'not-found' };
  if (TERMINAL_STATUSES.has(row.status)) return { ok: false, code: 'terminal-status', commitment: row };
  if (!evidence || typeof evidence !== 'object') return { ok: false, code: 'send-evidence-required' };
  if (evidence.kind !== 'send' || evidence.success !== true) return { ok: false, code: 'invalid-send-evidence' };
  const ref = cleanId(evidence.ref ?? evidence.transportRef);
  const messageId = cleanId(evidence.messageId);
  const executionId = cleanId(evidence.executionId);
  if (!ref || !messageId || !executionId) return { ok: false, code: 'incomplete-send-evidence' };
  if (row.execution_id && executionId !== row.execution_id) return { ok: false, code: 'execution-mismatch' };
  if (row.decision_id && cleanId(evidence.decisionId) && cleanId(evidence.decisionId) !== row.decision_id) return { ok: false, code: 'decision-mismatch' };
  if (row.send_ref) return { ok: true, applied: false, duplicate: true, commitment: row };
  const current = d.prepare('SELECT * FROM commitments WHERE id=?').get(cid);
  if (current.status === 'active') return { ok: true, applied: false, duplicate: true, commitment: current };
  if (!['proposed', 'uncertain'].includes(current.status)) return { ok: false, code: 'invalid-transition', commitment: current };
  const refs = dedupeEvidence([...parseEvidence(current.evidence_json), evidence]);
  const next = applyTransition(current, 'active', {
    activated_at: Number(activatedAt) || now(),
    evidence_json: safeJson(refs),
    execution_id: executionId,
    send_ref: ref,
  }, activatedAt);
  return { ok: true, applied: next.changes === 1, commitment: next.row };
}

/** 运输结果未知时不激活，只保守标为 uncertain；同一回执幂等。 */
export function markUncertainCommitment({ id, evidence = null, reason = 'transport-unknown', at = now() } = {}) {
  const d = openMemory();
  const cid = cleanId(id);
  if (!cid) return { ok: false, code: 'id-required' };
  const row = d.prepare('SELECT * FROM commitments WHERE id=?').get(cid);
  if (!row) return { ok: false, code: 'not-found' };
  if (TERMINAL_STATUSES.has(row.status)) return { ok: false, code: 'terminal-status', commitment: row };
  if (row.status === 'uncertain') return { ok: true, applied: false, duplicate: true, commitment: row };
  if (!['proposed', 'active'].includes(row.status)) return { ok: false, code: 'invalid-transition', commitment: row };
  if (!evidence || typeof evidence !== 'object' || evidence.kind !== 'transport' || evidence.success !== false) {
    return { ok: false, code: 'transport-unknown-evidence-required' };
  }
  const ref = cleanId(evidence.ref ?? evidence.transportRef);
  if (!ref) return { ok: false, code: 'transport-ref-required' };
  if (visibleRefs(row).has(ref)) return { ok: true, applied: false, duplicate: true, commitment: row };
  const refs = dedupeEvidence([...parseEvidence(row.evidence_json), evidence]);
  const next = applyTransition(row, 'uncertain', { evidence_json: safeJson(refs), reason: cleanText(reason, 120) }, at);
  return { ok: true, applied: next.changes === 1, commitment: next.row };
}

/**
 * 工具结果完成。必须指向 active 承诺，必须是新的工具回执；原始 request/send 证据不能重用。
 */
export function completeCommitment({ id, evidence = null, completedAt = now() } = {}) {
  const d = openMemory();
  const cid = cleanId(id);
  if (!cid) return { ok: false, code: 'id-required' };
  const row = d.prepare('SELECT * FROM commitments WHERE id=?').get(cid);
  if (!row) return { ok: false, code: 'not-found' };
  const knownRefs = visibleRefs(row);
  if (row.status === 'fulfilled') {
    if (evidence && typeof evidence === 'object' && knownRefs.has(cleanId(evidence.resultRef ?? evidence.ref))) {
      return { ok: true, applied: false, duplicate: true, commitment: row };
    }
    return { ok: false, code: 'terminal-status', commitment: row };
  }
  if (TERMINAL_STATUSES.has(row.status)) return { ok: false, code: 'terminal-status', commitment: row };
  if (row.status !== 'active') return { ok: false, code: 'commitment-not-active', commitment: row };
  if (!evidence || typeof evidence !== 'object') return { ok: false, code: 'tool-evidence-required' };
  if (evidence.kind !== 'tool' || evidence.success !== true) return { ok: false, code: 'invalid-tool-evidence' };

  // 修改授权：执行上下文的 scope 必须等于承诺 scope；shared 只读，不提权。
  const scope = cleanId(evidence.scope);
  if (!scope) return { ok: false, code: 'completion-scope-required' };
  if (scope !== cleanId(row.scope)) return { ok: false, code: 'scope-mismatch' };

  // 目标核对：模型声明不能代替真实接收者；缺 target 或错 target 都拒绝。
  const actualTargetId = cleanId(evidence.actualTargetId ?? evidence.targetId);
  if (cleanId(row.target_id)) {
    if (!actualTargetId) return { ok: false, code: 'actual-target-required' };
    if (actualTargetId !== cleanId(row.target_id)) return { ok: false, code: 'target-mismatch' };
  }

  const toolName = cleanId(evidence.toolName ?? evidence.tool);
  const action = cleanId(evidence.action);
  const resultRef = cleanId(evidence.resultRef ?? evidence.ref);
  const executionId = cleanId(evidence.executionId);
  if (!toolName || !action || !resultRef || !executionId) return { ok: false, code: 'incomplete-tool-evidence' };
  if (cleanId(evidence.commitmentId) && cleanId(evidence.commitmentId) !== cid) return { ok: false, code: 'commitment-id-mismatch' };
  if (knownRefs.has(resultRef)) return { ok: false, code: 'evidence-reuse-rejected' };
  const originalRefs = new Set([cleanId(row.request_ref), cleanId(row.request_message_id), cleanId(row.send_ref)].filter(Boolean));
  if (originalRefs.has(resultRef)) return { ok: false, code: 'original-evidence-reuse-rejected' };

  // 完成条件来自持久化事实；模型候选不能重新定义完成条件。
  const completionType = cleanId(row.completion_type) || 'unspecified';
  if (!SUPPORTED_COMPLETION_TYPES.includes(completionType)) {
    return { ok: false, code: 'unsupported-completion-type', completionType, commitment: row };
  }
  let condition = null;
  try { condition = JSON.parse(row.completion_condition_json || 'null'); } catch { condition = null; }
  if (!condition || typeof condition !== 'object') return { ok: false, code: 'completion-condition-missing' };
  if (completionType === 'deliver_message') {
    if (!COMPLETION_ACTIONS.has(action) || toolName !== 'qq-transport') {
      return { ok: false, code: 'completion-action-mismatch', completionType };
    }
    const expectedText = cleanText(condition.messageText, 600);
    const actualText = cleanText(evidence.messageText, 600);
    if (!expectedText || !actualText || expectedText !== actualText) {
      return { ok: false, code: 'completion-artifact-mismatch', completionType };
    }
  }

  const refs = dedupeEvidence([...parseEvidence(row.evidence_json), evidence]);
  const next = applyTransition(row, 'fulfilled', {
    completed_at: Number(completedAt) || now(),
    evidence_json: safeJson(refs),
    reason: 'tool-result-confirmed',
    fulfillment_ref: resultRef,
    fulfillment_tool: toolName,
    fulfillment_action: action,
  }, completedAt);
  return { ok: true, applied: next.changes === 1, commitment: next.row };
}

export function completeCommitmentFromToolResult({
  commitmentId = null, toolName = null, action = null, resultRef = null,
  success = true, scope = null, actualTargetId = null, messageText = null,
  decisionId = null, executionId = null, completionCandidate = null, at = now(),
} = {}) {
  const cid = cleanId(commitmentId);
  if (!cid) return { ok: false, code: 'commitment-id-required' };
  if (success !== true) return { ok: false, code: 'tool-result-not-successful' };
  // completionCandidate 只作审计来源；代码不采纳它定义的 target/type/condition。
  return completeCommitment({
    id: cid,
    evidence: {
      kind: 'tool', success: true, toolName: cleanId(toolName), action: cleanId(action),
      resultRef: cleanId(resultRef), commitmentId: cid,
      scope: cleanId(scope) || null,
      actualTargetId: cleanId(actualTargetId) || null,
      messageText: cleanText(messageText, 600),
      decisionId: cleanId(decisionId) || null,
      executionId: cleanId(executionId) || null,
      completionCandidate: completionCandidate && typeof completionCandidate === 'object'
        ? { commitmentId: cleanId(completionCandidate.commitmentId) }
        : null,
      at,
    },
    completedAt: at,
  });
}

export function withdrawCommitment({ id, reason = 'withdrawn', withdrawnAt = now() } = {}) {
  const d = openMemory();
  const cid = cleanId(id);
  if (!cid) return { ok: false, code: 'id-required' };
  const row = d.prepare('SELECT * FROM commitments WHERE id=?').get(cid);
  if (!row) return { ok: false, code: 'not-found' };
  if (row.status === 'withdrawn') return { ok: true, applied: false, duplicate: true, commitment: row };
  if (TERMINAL_STATUSES.has(row.status)) return { ok: false, applied: false, duplicate: false, code: 'terminal-status', commitment: row };
  const next = applyTransition(row, 'withdrawn', { reason: cleanText(reason, 120) }, withdrawnAt);
  return { ok: true, applied: next.changes === 1, duplicate: next.changes !== 1, commitment: next.row };
}

export function rescheduleCommitment({ id, dueAt, reason = 'rescheduled' } = {}) {
  const d = openMemory();
  const cid = cleanId(id);
  const due = Number(dueAt) || null;
  if (!cid || !due) return { ok: false, code: 'id-or-due-required' };
  const row = d.prepare('SELECT * FROM commitments WHERE id=?').get(cid);
  if (!row) return { ok: false, code: 'not-found' };
  if (TERMINAL_STATUSES.has(row.status)) return { ok: false, applied: false, duplicate: false, code: 'terminal-status', commitment: row };
  const next = applyTransition(row, row.status, { due_at: due, reason: cleanText(reason, 120) });
  return { ok: true, applied: next.changes === 1, duplicate: next.changes !== 1, commitment: next.row };
}

/** 过期由服务端时钟维护；不删除记录，已终结记录不动。 */
export function expireCommitments({ now: at = now() } = {}) {
  const d = openMemory();
  const rows = d.prepare(`SELECT id FROM commitments
    WHERE status IN ('proposed','active','uncertain') AND due_at IS NOT NULL AND due_at < ?`).all(Number(at) || now());
  for (const row of rows) {
    const current = d.prepare('SELECT * FROM commitments WHERE id=?').get(row.id);
    if (!current || TERMINAL_STATUSES.has(current.status)) continue;
    applyTransition(current, 'expired', { reason: 'due-passed' }, at);
  }
  return { ok: true, applied: rows.length > 0, duplicate: false, expired: rows.length };
}

export function getCommitment({ id } = {}) {
  const d = openMemory();
  const cid = cleanId(id);
  if (!cid) return null;
  return d.prepare('SELECT * FROM commitments WHERE id=?').get(cid) ?? null;
}

export function listCommitments({ scopes = [], statuses = ['proposed', 'active', 'uncertain'], limit = 6 } = {}) {
  const d = openMemory();
  const scopeList = normalizeScopeList(scopes);
  const statusList = (Array.isArray(statuses) ? statuses : []).map(String).filter(Boolean);
  if (!scopeList.length || !statusList.length) return [];
  const args = [...scopeList, ...statusList];
  return d.prepare(`SELECT * FROM commitments
    WHERE scope IN (${scopeList.map(() => '?').join(',')})
      AND status IN (${statusList.map(() => '?').join(',')})
    ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, Math.max(1, Math.min(50, Number(limit) || 6)));
}

function normalizedOutgoing(text) {
  return cleanText(text, 600);
}

/**
 * bridge 发送回执激活：按 decision/execution 与完整 messageText 对应，不做子串匹配。
 * success=false 或 messageId 缺失时绝不激活。
 */
export function activateCommitmentsForSendReceipt({
  scope, decision = null, executionId = null, messageId = null,
  transportRef = null, messageText = '', success = true, at = now(),
} = {}) {
  const s = cleanText(scope, 128);
  const decId = cleanId(decision?.decisionId ?? decision?.id);
  const execId = cleanId(executionId);
  const msgId = cleanId(messageId ?? transportRef);
  const text = normalizedOutgoing(messageText);
  if (!s || !decId || !execId) return { activated: 0, checked: 0, code: 'decision-or-execution-required' };
  if (!msgId || !text) return { activated: 0, checked: 0, code: 'send-receipt-incomplete' };
  if (success !== true) return { activated: 0, checked: 0, code: 'send-not-successful' };
  const proposals = listCommitments({ scopes: [s], statuses: ['proposed', 'uncertain'], limit: 20 })
    .filter((c) => c.decision_id === decId && (!c.execution_id || c.execution_id === execId));
  let activated = 0;
  for (const c of proposals) {
    if (cleanText(c.message_text, 600) !== text) continue;
    const r = activateCommitment({
      id: c.id,
      evidence: {
        kind: 'send', success: true, ref: cleanId(transportRef) || `send:${msgId}`,
        messageId: msgId, transportRef: cleanId(transportRef) || `send:${msgId}`,
        executionId: execId, decisionId: decId, messageText: text, at,
      },
      activatedAt: at,
    });
    if (r?.ok && r?.applied) activated += 1;
  }
  return { activated, checked: proposals.length };
}

/** 提示行：不命令模型必须完成，只提醒可解释、改期或撤回。 */
export function commitmentPromptLine(commitments) {
  const list = (Array.isArray(commitments) ? commitments : []).filter((c) => ['proposed', 'active', 'uncertain'].includes(String(c?.status ?? '')));
  if (!list.length) return '';
  const fmt = (ms) => { try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const lines = list.slice(0, 3).map((c) => {
    const due = Number(c.due_at || c.dueAt || 0);
    return `- ${String(c.text).slice(0, 100)}（${c.status}${due ? `；到期 ${fmt(due)}` : ''}）`;
  }).join('\n');
  return `【当前承诺/未决】\n${lines}\n未兑现的承诺可以解释、改期或撤回；不要为了完成所有请求强行答应。\n\n`;
}
