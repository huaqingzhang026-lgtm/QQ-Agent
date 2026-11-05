// OneBot 外发传输层（S3 前置）：所有 QQ 文本/表情/图片的 HTTP 调用都从这里出去。
//
// 目的（改造方案 §1.7 / §6.1）：
//   · dry-run 必须在**最终外部传输前**截断，而不是靠提示词"别发"；
//   · 让回放测试能注入假 fetch，断言外部调用次数；
//   · 统一记录 intent（目标、动作、模式），为后续 outbox/去重/配额预占留入口。
//
// 行为约束：
//   · 默认 live，行为与直连 fetch 完全一致（同样的超时、头、body）；
//   · QQ_DRY_RUN=1 时只记录 intent 并返回成功形状，绝不发起网络请求；
//   · 传输层不解释业务错误，只把 {ok, status, body} 交给调用方决定。

import { emitEvent } from './trace.js';

let DRY_RUN = String(process.env.QQ_DRY_RUN ?? '') === '1';

/** 运行期开关：桥接启动时按 config 设置（QQ_DRY_RUN=1 仍可覆盖为 true）。 */
export function setDryRun(value) {
  if (value === true) DRY_RUN = true;
  else if (value === false && String(process.env.QQ_DRY_RUN ?? '') !== '1') DRY_RUN = false;
}

const stats = { attempted: 0, sent: 0, blocked: 0, failed: 0 };

export function transportMode() {
  return DRY_RUN ? 'dry-run' : 'live';
}

export function transportStats() {
  return { ...stats, mode: transportMode() };
}

export function resetTransportStats() {
  stats.attempted = 0;
  stats.sent = 0;
  stats.blocked = 0;
  stats.failed = 0;
}

/**
 * 提交一次 OneBot 动作。
 * @param {{action: string, params: object, httpUrl: string, accessToken?: string,
 *          timeoutMs?: number, fetchImpl?: Function}} input
 * @returns {Promise<{ok: boolean, status: number, body: object, dryRun?: boolean}>}
 */
export async function postOneBot({
  action,
  params,
  httpUrl,
  accessToken,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
}) {
  const target = params?.group_id ?? params?.user_id ?? null;
  stats.attempted += 1;

  if (DRY_RUN) {
    stats.blocked += 1;
    emitEvent({
      decision: 'send-blocked-dry-run',
      triggerType: String(action),
      conversationKey: target === null ? '' : `${params?.group_id ? 'group' : 'private'}:${target}`,
      reasonCode: 'DRY_RUN',
      policyVersion: 'transport/1',
    });
    return {
      ok: true,
      status: 200,
      dryRun: true,
      body: { status: 'ok', retcode: 0, data: { dryRun: true, action, target } },
    };
  }

  const url = String(httpUrl ?? '').replace(/\/+$/, '');
  const res = await fetchImpl(`${url}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  const ok = Boolean(res.ok) && body?.status === 'ok' && body?.retcode === 0;
  if (ok) stats.sent += 1;
  else stats.failed += 1;
  emitEvent({
    decision: ok ? 'sent' : 'send-failed',
    triggerType: String(action),
    conversationKey: target === null ? '' : `${params?.group_id ? 'group' : 'private'}:${target}`,
    reasonCode: ok ? 'SENT' : `HTTP_${res.status}`,
    policyVersion: 'transport/1',
  });
  return { ok, status: res.status, body };
}

export default { postOneBot, transportMode, transportStats, resetTransportStats };
