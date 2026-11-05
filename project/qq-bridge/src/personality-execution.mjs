// A03 回合执行上下文：服务端签发的不可伪造回合凭证。
// 纯函数；不读写文件、不联网。实际注册表在 bridge 内。
import crypto from 'node:crypto';

export const EXECUTION_SCHEMA_VERSION = 1;
export const EXECUTION_ACTIONS = new Set([
  'send_message', 'reply', 'poke', 'voice', 'sticker', 'image', 'wait', 'mark_read', 'no_send',
]);

export function createExecutionContext({
  key, decision, sessionId = null, epoch = 0, seq = 0,
  now = Date.now(), ttlMs = 6 * 60 * 1000, turnId = null,
} = {}) {
  if (!key || !decision?.decisionId) throw new Error('execution 需要 key 和 decisionId');
  const ts = Number(now);
  const expiresAt = decision.expiresAt || new Date(ts + Math.max(1000, Number(ttlMs) || 360000)).toISOString();
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    executionId: crypto.randomBytes(18).toString('base64url'),
    key: String(key),
    sessionId: sessionId == null ? null : String(sessionId),
    turnId: turnId == null ? `pending-${ts}-${crypto.randomBytes(6).toString('hex')}` : String(turnId),
    turnBound: turnId != null,
    decisionId: String(decision.decisionId),
    epoch: Number(epoch) || 0,
    seq: Number(seq) || 0,
    contextRevision: Number(decision.contextRevision) || 0,
    expiresAt,
    createdAt: ts,
    cancelledAt: 0,
    cancelReason: '',
    transported: [],
  };
}

export function cancelExecutionContext(context, { now = Date.now(), reason = 'cancelled' } = {}) {
  if (!context) return context;
  if (!context.cancelledAt) { context.cancelledAt = Number(now) || Date.now(); context.cancelReason = String(reason || 'cancelled'); }
  return context;
}

export function executionPromptLine(context) {
  if (!context?.executionId) return '';
  return [
    '【本轮执行凭证】',
    `executionId=${context.executionId}`,
    `这是本回合专用的发送凭证，不是会话长期 token。调用 qq_send_message / qq_send_burst / qq_reply / qq_send_poke / qq_send_voice / qq_send_sticker / 图片发送时，必须把 executionId 一起传入；不要复用旧回合或别的会话的 executionId。`,
    '',
  ].join('\n') + '\n';
}

export function validateExecutionContext(context, {
  key, action, now = Date.now(), decision = null,
  activeExecutionId = null, currentEpoch = null,
  lastUnreadSeq = null, sessionId = null, snapshotRevision = null,
} = {}) {
  if (!context) return { ok: false, code: 'execution-missing', error: '缺少本轮执行凭证' };
  if (context.schemaVersion !== EXECUTION_SCHEMA_VERSION) return { ok: false, code: 'execution-invalid', error: '执行凭证版本不支持' };
  if (String(context.key) !== String(key)) return { ok: false, code: 'execution-cross-scope', error: '执行凭证不属于当前会话' };
  if (context.cancelledAt) return { ok: false, code: 'execution-cancelled', error: '本回合已取消' };
  if (activeExecutionId != null && String(context.executionId) !== String(activeExecutionId)) return { ok: false, code: 'execution-replaced', error: '执行凭证已被新回合替换' };
  if (currentEpoch != null && Number(context.epoch) !== Number(currentEpoch)) return { ok: false, code: 'execution-stale-epoch', error: '执行凭证已过期（回合代次变化）' };
  if (decision && String(context.decisionId) !== String(decision.decisionId)) return { ok: false, code: 'execution-decision-mismatch', error: '执行凭证与本轮决策不匹配' };
  if (lastUnreadSeq != null && Number(context.seq) !== Number(lastUnreadSeq)) return { ok: false, code: 'execution-stale-message', error: '新消息已进入，旧执行凭证失效' };
  if (sessionId !== undefined && context.sessionId != null && String(sessionId) !== String(context.sessionId)) return { ok: false, code: 'execution-session-changed', error: '会话已替换' };
  if (snapshotRevision != null && Number(context.contextRevision) !== Number(snapshotRevision)) return { ok: false, code: 'execution-stale-revision', error: '人格状态版本已变化' };
  if (!Number.isFinite(Date.parse(context.expiresAt)) || Date.parse(context.expiresAt) <= Number(now)) return { ok: false, code: 'execution-expired', error: '执行凭证已过期' };
  if (action && !EXECUTION_ACTIONS.has(String(action))) return { ok: false, code: 'execution-invalid-action', error: '动作类型不合法' };
  if (decision && Array.isArray(decision.allowedActions) && !decision.allowedActions.includes(String(action))) return { ok: false, code: 'execution-action-not-allowed', error: '本轮决策不允许该动作' };
  return { ok: true };
}

export function recordTransport(context, { action = '', messageId = null, now = Date.now() } = {}) {
  if (context && Array.isArray(context.transported)) context.transported.push({ action, messageId, at: Number(now) });
  return context;
}
