// 外发网关 v2（S3）：意图 → 授权/去重/配额**原子预占** → 传输 → 终态 → outbox 恢复。
//
// 对 v1 的修正（对应独立验收 F04/F05/F06）：
//   1. 去重与配额在**进入异步发送之前**同步占位：并发调用不会同时通过检查；
//   2. sending/unknown 都保留占位，避免"结果不确定时再发一次"；
//   3. 意图必须**先可靠落盘**才允许外发；落盘失败直接 failed，不发；
//   4. 传输结果按 ok 字段判定：ok=false（HTTP 429 / retcode!=0）记 failed，不再记 sent；
//   5. 新实例启动时从 outbox 重建：reserved/sending → unknown（待核对），
//      sent/unknown 重建去重与配额占用，避免重启后预算被清零。

import fs from 'node:fs';

export const STATES = ['queued', 'reserved', 'sending', 'sent', 'failed', 'unknown', 'expired', 'cancelled'];

const DEFAULT = {
  quotaEnabled: false,
  perMinute: 10,
  perHour: 300,
  dedupeTtlMs: 120000,
  intentTtlMs: 60000,
  outboxMaxLines: 5000,
};

function shortHash(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 判断传输结果：显式 ok=false 视为明确失败；抛异常由调用方归为 unknown。 */
export function classifyResult(result) {
  if (!result || typeof result !== 'object') return 'sent';
  if (result.unknown === true) return 'unknown';
  if (result.ok === false) return 'failed';
  return 'sent';
}

export function createGateway({ cfg, now = () => Date.now(), outboxFile = null, log = () => {} } = {}) {
  const o = { ...DEFAULT, ...(cfg ?? {}) };
  const dedupe = new Map(); // dedupeKey -> { at, state, intentId }
  const quotas = new Map(); // conversationKey -> number[]
  const pending = new Map(); // intentId -> intent（仅本次进程）
  let seq = 0;

  function writeLine(intent) {
    if (!outboxFile) return true; // 无 outbox（纯内存模式）：视为可持久
    try {
      fs.mkdirSync(requireDir(outboxFile), { recursive: true });
      fs.appendFileSync(outboxFile, `${JSON.stringify(intent)}\n`, 'utf8');
      return true;
    } catch (e) {
      log(`[gateway] outbox 写入失败：${e?.message ?? e}`);
      return false;
    }
  }

  function requireDir(file) {
    const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    return idx > 0 ? file.slice(0, idx) : '.';
  }

  function quotaSnapshot(conversationKey, at) {
    const list = (quotas.get(conversationKey) ?? []).filter((t) => at - t < 3600000);
    quotas.set(conversationKey, list);
    return {
      minute: list.filter((t) => at - t < 60000).length,
      hour: list.length,
    };
  }

  function quotaReserve(conversationKey, segments, at) {
    if (!o.quotaEnabled) return { ok: true, reserved: 0 };
    const snap = quotaSnapshot(conversationKey, at);
    if (snap.minute + segments > o.perMinute || snap.hour + segments > o.perHour) {
      return { ok: false, reserved: 0, reason: 'rate-limited' };
    }
    const list = quotas.get(conversationKey) ?? [];
    for (let i = 0; i < segments; i++) list.push(at);
    quotas.set(conversationKey, list.slice(-2000));
    return { ok: true, reserved: segments };
  }

  function quotaRelease(conversationKey, segments) {
    if (!o.quotaEnabled || segments <= 0) return;
    const list = quotas.get(conversationKey) ?? [];
    list.splice(Math.max(0, list.length - segments), segments);
    quotas.set(conversationKey, list);
  }

  /** 启动恢复：从 outbox 重建状态。 */
  function recover() {
    if (!outboxFile) return { recovered: 0, restored: 0 };
    let text = '';
    try { text = fs.readFileSync(outboxFile, 'utf8'); } catch { return { recovered: 0, restored: 0 }; }
    let recovered = 0;
    let restored = 0;
    const live = new Map(); // intentId -> last state
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // 截断行直接跳过
      if (!rec || !rec.intentId) continue;
      live.set(rec.intentId, rec);
    }
    for (const rec of live.values()) {
      if (rec.state === 'reserved' || rec.state === 'sending') {
        const fixed = { ...rec, state: 'unknown', detail: 'recovered-after-restart', at: now() };
        writeLine(fixed);
        recovered += 1;
      }
      if (rec.state === 'sent' || rec.state === 'unknown') {
        restored += 1;
        if (rec.dedupeKey) dedupe.set(rec.dedupeKey, { at: Number(rec.at) || now(), state: rec.state, intentId: rec.intentId });
        if (o.quotaEnabled && rec.conversationKey) {
          const list = quotas.get(rec.conversationKey) ?? [];
          const at = Number(rec.at) || now();
          const segs = Math.max(1, Number(rec.segments) || 1);
          for (let i = 0; i < segs; i++) list.push(at);
          quotas.set(rec.conversationKey, list.slice(-2000));
        }
      }
    }
    if (recovered) log(`[gateway] 恢复：${recovered} 条未确认外发标为 unknown，${restored} 条历史用于重建预算/去重`);
    return { recovered, restored };
  }

  /**
   * @returns {Promise<{state: string, detail?: string, duplicate?: boolean, intentId: string, result?: any}>}
   */
  async function submit(input) {
    const at = now();
    const conversationKey = String(input?.conversationKey ?? '');
    const segments = Math.max(1, Number(input?.segments) || 1);
    const dedupeKey = input?.dedupeKey ? `${conversationKey}|${input.kind}|${input.dedupeKey}` : '';
    const intentId = `oi-${at.toString(36)}-${(++seq).toString(36)}-${shortHash(conversationKey + (input?.dedupeKey ?? ''))}`;

    // 1) 授权
    const allowed = input?.allowedKeys;
    if (allowed) {
      const set = allowed instanceof Set ? allowed : new Set(allowed);
      if (set.size > 0 && !set.has(conversationKey)) {
        return { state: 'failed', detail: 'target-not-allowed', intentId };
      }
    }

    // 2) 去重占位（同步，先占后发）
    if (dedupeKey) {
      const hit = dedupe.get(dedupeKey);
      if (hit && at - hit.at < o.dedupeTtlMs) {
        return { state: hit.state, duplicate: true, intentId: hit.intentId };
      }
      dedupe.set(dedupeKey, { at, state: 'reserved', intentId });
    }

    // 3) 配额预占（同步，先占后发）
    const reserved = quotaReserve(conversationKey, segments, at);
    if (!reserved.ok) {
      if (dedupeKey) dedupe.delete(dedupeKey);
      return { state: 'failed', detail: reserved.reason || 'rate-limited', intentId };
    }

    const intent = {
      intentId, at, conversationKey,
      kind: String(input?.kind ?? 'text'),
      segments,
      source: String(input?.source ?? 'bridge'),
      state: 'reserved',
      dedupeKey,
      payload: input?.payload ?? null,
    };

    // 4) 先落盘，再外发；落盘失败 → 不发送
    if (!writeLine(intent)) {
      quotaRelease(conversationKey, segments);
      if (dedupeKey) dedupe.delete(dedupeKey);
      return { state: 'failed', detail: 'outbox-write-failed', intentId };
    }

    pending.set(intentId, intent);
    intent.state = 'sending';

    // 5) 执行
    let result;
    try {
      result = await input.send();
    } catch (e) {
      const msg = String(e?.message ?? e);
      intent.state = 'unknown';
      intent.detail = msg.slice(0, 200);
      writeLine(intent);
      if (dedupeKey) dedupe.set(dedupeKey, { at, state: 'unknown', intentId });
      pending.delete(intentId);
      log(`[gateway] ${conversationKey} ${intent.kind} unknown（可能已发出，保留占位）`);
      return { state: 'unknown', detail: msg.slice(0, 120), intentId };
    }

    const verdict = classifyResult(result);
    intent.state = verdict;
    intent.result = result ?? null;
    if (verdict === 'failed') intent.detail = String(result?.detail ?? result?.status ?? 'transport-not-ok').slice(0, 200);
    if (!writeLine(intent)) {
      // 终态写不进去：按 unknown 处理，避免误以为已确认
      log(`[gateway] 终态写入失败，按 unknown 处理 ${conversationKey}`);
      pending.delete(intentId);
      return { state: 'unknown', detail: 'outbox-final-write-failed', intentId };
    }
    pending.delete(intentId);

    if (verdict === 'sent') {
      if (dedupeKey) dedupe.set(dedupeKey, { at, state: 'sent', intentId });
      return { state: 'sent', intentId, result };
    }

    // 明确失败：释放配额与去重占位
    quotaRelease(conversationKey, segments);
    if (dedupeKey) dedupe.delete(dedupeKey);
    return { state: 'failed', detail: intent.detail, intentId, result };
  }

  return {
    submit,
    recover,
    stats: () => ({ pending: pending.size, dedupe: dedupe.size, quotaEnabled: o.quotaEnabled }),
  };
}
