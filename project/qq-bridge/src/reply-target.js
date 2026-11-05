// 引用目标解析（纯函数）：把「模型给的一串数字」判定成**哪一种 id**。
//
// 背景：桥接里同时存在两套 id
//   · seq        —— 本地会话内自增的小整数（1,2,3…），只用于桥接内部水位/分页；
//   · messageId  —— QQ/OneBot 的消息 id（大整数，可能为负），真正能用来引用。
// 二者的取值范围会重叠，且 recentMessages 只保留最近 N 条 —— 更早的 seq 会被裁掉。
//
// 旧实现（bridge.js 的 resolveReplyTargetV2）的兜底是：
//   「先在 recentMessages 里按 seq 找，找不到就把这串数字直接当成 message_id 去 get_msg」。
// 于是「一个已经被裁掉的旧 seq」会被当作某个真实 message_id 去查询，命中同群另一条
// 无关消息 —— 这就是群里 @ 她时「引用串到别的消息」的来源：不报错、静默引错。
//
// 这里把它收成一条明确规则：
//   1) 同时命中「某条的 messageId」和「另一条的 seq」→ 歧义，拒绝（让调用方改用 messageId）；
//   2) 命中 messageId → 就是 messageId（规范身份，优先）；
//   3) 命中 seq 且该条有真实 messageId → 映射成 messageId；没有 messageId → 拒绝，绝不猜；
//   4) 都没命中，但数值落在本地 seq 区间 (0, lastUnreadSeq] → 判定成「过期 seq」，拒绝；
//   5) 其余才按 messageId 交给 OneBot 校验（归属校验在 resolveReplyInfo 里）。
// 「拒绝」永远优于「猜一条消息去引用」。

export const REPLY_REF = {
  MESSAGE_ID: 'messageId',
  SEQ: 'seq'
};

function toStr(value) {
  return value == null ? '' : String(value);
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {object} params
 * @param {string|number} params.ref            调用方给的消息引用（seq 或 messageId）
 * @param {Array} params.recentMessages         当前会话的 recentMessages
 * @param {number} params.lastUnreadSeq         当前会话已分配的最大 seq
 * @returns {{ok:true,kind:string,messageId:string,message:object|null,seq?:number}
 *          |{ok:false,reason:string,detail:string,seq?:number}}
 */
export function resolveReplyRef({ ref, recentMessages, lastUnreadSeq = 0 } = {}) {
  const raw = toStr(ref).trim();
  if (!raw) return { ok: false, reason: 'empty', detail: '引用 id 为空' };
  if (!/^-?\d+$/.test(raw)) {
    return { ok: false, reason: 'not-integer', detail: '引用 id 必须是整数（QQ 消息 id 可能为负数）' };
  }

  const list = listOf(recentMessages);
  const byMessageId = list.filter((m) => m && m.messageId != null && toStr(m.messageId) === raw);
  const bySeq = list.filter((m) => m && m.seq != null && toStr(m.seq) === raw);

  // 同一串数字既是 A 的 messageId 又是 B 的 seq：无从判断，直接拒绝。
  if (byMessageId.length && bySeq.length && byMessageId[0] !== bySeq[0]) {
    return {
      ok: false,
      reason: 'ambiguous',
      detail: `id ${raw} 同时像本地 seq ${raw} 和某条消息的 messageId，无法判断你指的是哪一条；请改用 qq_get_recent_messages 返回的 messageId`
    };
  }

  if (byMessageId.length) {
    const hit = byMessageId[byMessageId.length - 1];
    return { ok: true, kind: REPLY_REF.MESSAGE_ID, messageId: raw, message: hit, seq: hit.seq };
  }

  if (bySeq.length) {
    const hit = bySeq[bySeq.length - 1];
    if (hit.messageId == null || toStr(hit.messageId) === '') {
      // 本地只有 seq、没有真实 messageId：引用不出去，也不要拿 seq 去冒充。
      return {
        ok: false,
        reason: 'seq-without-message-id',
        seq: hit.seq,
        detail: `本地消息 seq=${hit.seq} 没有对应的真实 messageId（可能是桥接自己合成的消息），无法引用；请换一条 QQ 消息`
      };
    }
    return { ok: true, kind: REPLY_REF.SEQ, messageId: toStr(hit.messageId), message: hit, seq: hit.seq };
  }

  const numeric = Number(raw);
  const maxSeq = Number(lastUnreadSeq) || 0;
  // 只有本地确实存在历史时才做「过期 seq」判定：空历史 + 有水位（重启后还没收到消息）
  // 的情况下，一个小的 messageId 不该被误杀。
  if (list.length > 0 && Number.isSafeInteger(numeric) && numeric > 0 && numeric <= maxSeq) {
    // 落在本地 seq 区间内，但 recentMessages 里已经没有它 —— 典型是「被裁掉的旧 seq」。
    // 这类数字一旦被当成 messageId 查询，就会静默命中别的消息。
    return {
      ok: false,
      reason: 'stale-seq',
      seq: numeric,
      detail: `seq=${numeric} 已经不在当前会话的最近消息里（本地 seq 最大到 ${maxSeq}），不能当作 messageId 使用；请用 qq_get_recent_messages 里的 messageId`
    };
  }

  return { ok: true, kind: REPLY_REF.MESSAGE_ID, messageId: raw, message: null };
}

/** 把解析失败的原因转成一句给人/给模型看的话。 */
export function replyRefErrorText(result) {
  if (!result || result.ok !== false) return '';
  return result.detail || '无法解析被引用消息，请确认 id 正确且属于当前会话';
}
