// 下一次唤醒的时间语义（纯函数）：mode / infinite / sleepUntil 三者怎么组合。
//
// 旧实现（bridge.js 的 /api/socialV2/wake-config）把「继承来的值」和「本次显式传入的值」
// 混在一个 `if (next.infinite) next.sleepUntil = null` 里：
//   · infinite 是从**当前配置**继承的（缺省字段保留原值）；
//   · 于是「当前是无限期潜水」时，哪怕这次明确传了 sleepMs/sleepUntil（想约一个定时唤醒），
//     算出来的 sleepUntil 也会被这一行无条件清掉 —— 定时唤醒被潜水设置静默覆盖，
//     接口还返回 ok:true，从日志上只能看到 sleepUntil=null。
// 反过来，mode:'active' 也会无条件清 sleepUntil。
//
// 这里把优先级写死，谁显式谁生效：
//   1) mode=active            → 无定时器（anyMessage 全唤醒）
//   2) 显式 infinite=true     → 无限期潜水，清空定时器
//   3) 显式 sleepUntil/sleepMs → 有限潜水，必须留下这个时间点（就算当前是无限期潜水）
//   4) 显式 infinite=false    → 有限潜水；保留仍在未来的原定时器，否则用推荐默认时长
//   5) 什么都没传             → 原样保留当前 infinite 与仍在未来的 sleepUntil
// 另外：显式传入但解析不了的 sleepUntil 不再静默退化成「随机 5 分钟~2 小时」，
// 而是返回错误 —— 静默改写时间点和静默引错消息是同一类问题。

const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 解析 sleepUntil：支持 ISO/可被 Date.parse 的绝对时间，以及 "HH:MM"/"HH:MM:SS"
 * （按本机时区，晚于当前则今天，否则明天）。
 * @returns {{ok:true, ts:number}|{ok:false, error:string}}
 */
export function parseSleepUntil(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'sleepUntil 为空' };
  const clock = CLOCK_RE.exec(raw);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    const second = Number(clock[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) {
      return { ok: false, error: `sleepUntil 时间不合法：${raw}` };
    }
    const at = new Date(now);
    at.setHours(hour, minute, second, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return { ok: true, ts: at.getTime() };
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: `sleepUntil 无法解析：${raw}（用 ISO 时间或 HH:MM）` };
  }
  return { ok: true, ts };
}

function clampFireTime(ts, now, limits) {
  const minMs = Math.max(0, num(limits.sleepMinMs, 0));
  const maxMs = Math.max(0, num(limits.sleepMaxMs, 0));
  let out = ts;
  if (minMs > 0 && out < now + minMs) out = now + minMs;
  if (maxMs > 0 && out > now + maxMs) out = now + maxMs;
  return out;
}

function defaultFiniteUntil(now, limits, random) {
  const recMin = num(limits.recommendedSleepMinMs, 300000);
  const recMax = num(limits.recommendedSleepMaxMs, 7200000);
  const span = Math.max(0, recMax - recMin);
  return now + Math.round(recMin + random() * span);
}

function futureUntil(current, now) {
  const value = current?.sleepUntil;
  if (typeof value !== 'string' || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > now ? value : null;
}

/**
 * @param {object} params
 * @param {object} params.current  当前 wakeConfig（只读）
 * @param {object} params.input    本次请求里的 config
 * @param {string} params.mode     归一化后的目标 mode（active/diving）
 * @param {number} [params.now]
 * @param {object} [params.limits] cfg.socialV2.wake
 * @param {Function} [params.random] 注入随机源，便于测试
 * @returns {{ok:true, infinite:boolean, sleepUntil:string|null, source:string}
 *          |{ok:false, error:string}}
 */
export function resolveWakeTiming({ current = {}, input = {}, mode, now = Date.now(), limits = {}, random = Math.random } = {}) {
  const targetMode = mode === 'active' ? 'active' : 'diving';
  const hasSleepUntil = input.sleepUntil != null && String(input.sleepUntil).trim() !== '';
  const hasSleepMs = input.sleepMs !== undefined && input.sleepMs !== null && input.sleepMs !== ''
    && Number.isFinite(Number(input.sleepMs));
  const hasScheduleInput = hasSleepUntil || hasSleepMs;

  if (targetMode === 'active') {
    // 活跃模式靠 anyMessage 唤醒，不需要定时器；这是显式语义，不是覆盖。
    return { ok: true, infinite: true, sleepUntil: null, source: 'active' };
  }

  if (input.infinite === true && hasScheduleInput) {
    return { ok: false, error: 'infinite=true 与 sleepMs/sleepUntil 互斥：要无限期潜水就不要传定时，要定时就传 infinite=false' };
  }

  if (input.infinite === true) {
    return { ok: true, infinite: true, sleepUntil: null, source: 'explicit-infinite' };
  }

  if (hasScheduleInput) {
    if (hasSleepUntil) {
      const parsed = parseSleepUntil(input.sleepUntil, now);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.ts <= now) return { ok: false, error: `sleepUntil 已经过去：${input.sleepUntil}` };
      return { ok: true, infinite: false, sleepUntil: new Date(clampFireTime(parsed.ts, now, limits)).toISOString(), source: 'explicit-schedule' };
    }
    let ms = Math.max(0, Math.round(Number(input.sleepMs)));
    if (ms <= 0) return { ok: false, error: 'sleepMs 必须大于 0' };
    const minMs = Math.max(0, num(limits.sleepMinMs, 0));
    const maxMs = Math.max(0, num(limits.sleepMaxMs, 0));
    if (ms < minMs) ms = minMs;
    if (maxMs > 0 && ms > maxMs) ms = maxMs;
    return { ok: true, infinite: false, sleepUntil: new Date(now + ms).toISOString(), source: 'explicit-schedule' };
  }

  if (input.infinite === false) {
    const kept = futureUntil(current, now);
    return {
      ok: true,
      infinite: false,
      sleepUntil: kept || new Date(defaultFiniteUntil(now, limits, random)).toISOString(),
      source: kept ? 'explicit-finite' : 'default-finite'
    };
  }

  // 什么都没传：缺省字段保留原值（工具描述就是这么承诺的）。
  if (current.infinite === true) {
    return { ok: true, infinite: true, sleepUntil: null, source: 'inherit' };
  }
  const kept = futureUntil(current, now);
  return {
    ok: true,
    infinite: false,
    sleepUntil: kept || new Date(defaultFiniteUntil(now, limits, random)).toISOString(),
    source: kept ? 'inherit' : 'default-finite'
  };
}
