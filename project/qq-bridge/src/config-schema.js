// 配置校验（S7.3）：把"非法值静默生效"变成"启动时明确报告 + 收敛到安全范围"。
//
// 原则：
//   · 结构缺失 → 用默认值补齐（warning）；
//   · 数值越界 → 夹到合法区间（warning），不静默接受危险值；
//   · 类型错误/无法修复 → error（调用方决定是否拒绝启动）。
//
// 纯函数，便于回放。

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function clamp(name, value, min, max, ctx, { integer = false } = {}) {
  const errors = ctx?.errors ?? ctx;
  const warnings = ctx?.warnings ?? [];
  const n = num(value);
  if (n === null) {
    errors.push(`${name} 不是数字（实际：${JSON.stringify(value)}），已拒绝该字段`);
    return undefined;
  }
  let v = Math.min(max, Math.max(min, n));
  if (integer) v = Math.round(v);
  if (v !== n) warnings.push(`${name}=${n} 越界，已收敛到 ${v}（允许 ${min}..${max}）`);
  return v;
}

export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];
  if (cfg === null || cfg === undefined || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, errors: ['config 必须是对象'], warnings, sanitized: {} };
  }
  const out = JSON.parse(JSON.stringify(cfg));

  // allow / deny
  for (const key of ['private', 'groups']) {
    const v = out.allow?.[key];
    if (v !== undefined) {
      if (!Array.isArray(v)) errors.push(`allow.${key} 必须是数组`);
      else {
        const bad = v.filter((x) => typeof x !== 'string' && typeof x !== 'number');
        if (bad.length) errors.push(`allow.${key} 含非法项：${JSON.stringify(bad.slice(0, 3))}`);
        out.allow[key] = v.map(String);
      }
    }
  }

  // model
  if (out.model !== undefined && (typeof out.model !== 'string' || !out.model.trim())) {
    errors.push('model 必须是非空字符串');
  }

  // snowluma
  if (out.snowluma?.httpUrl !== undefined) {
    const u = String(out.snowluma.httpUrl);
    if (!/^https?:\/\//i.test(u)) errors.push('snowluma.httpUrl 必须是 http(s) URL');
  }

  const s = out.socialV2;

  // send
  if (s?.send) {
    const m = clamp('socialV2.send.maxSendPerMinute', s.send.maxSendPerMinute, 1, 30, { errors, warnings }, { integer: true });
    if (m !== undefined) s.send.maxSendPerMinute = m;
    const h = clamp('socialV2.send.maxSendPerHour', s.send.maxSendPerHour, 1, 2000, { errors, warnings }, { integer: true });
    if (h !== undefined) s.send.maxSendPerHour = h;
  }

  // wake
  if (s?.wake) {
    const w = s.wake;
    for (const k of ['ignoreProbability', 'ignoreAtMentionProbability', 'pokeReplyProbability']) {
      if (w[k] !== undefined) {
        const v = clamp(`socialV2.wake.${k}`, w[k], 0, 1, { errors, warnings });
        if (v !== undefined) w[k] = v;
      }
    }
    for (const k of ['maxWakePerMinute', 'maxWakePerHour']) {
      if (w[k] !== undefined) {
        const v = clamp(`socialV2.wake.${k}`, w[k], 1, 200, { errors, warnings }, { integer: true });
        if (v !== undefined) w[k] = v;
      }
    }
    const cd = clamp('socialV2.wake.atMentionCooldownMs', w.atMentionCooldownMs ?? 0, 0, 3600000, { errors, warnings }, { integer: true });
    if (cd !== undefined) w.atMentionCooldownMs = cd;
  }

  // proactive
  if (s?.proactive) {
    const p = clamp('socialV2.proactive.probability', s.proactive.probability, 0, 1, { errors, warnings });
    if (p !== undefined) s.proactive.probability = p;
    const m = clamp('socialV2.proactive.maxPerHour', s.proactive.maxPerHour, 0, 20, { errors, warnings }, { integer: true });
    if (m !== undefined) s.proactive.maxPerHour = m;
    for (const [scope, ov] of Object.entries(s.proactive.conversationOverrides ?? s.proactive.groupOverrides ?? {})) {
      if (ov && ov.probability !== undefined) {
        const pv = num(ov.probability);
        if (pv === null || pv < 0 || pv > 1) errors.push(`proactive.${scope}.probability 必须在 0..1（实际：${JSON.stringify(ov.probability)}）`);
      }
      if (ov && ov.probability !== undefined) {
        const v = clamp(`proactive.${scope}.probability`, ov.probability, 0, 1, { errors, warnings });
        if (v !== undefined) ov.probability = v;
      }
    }
  }

  // A04 relationship cooldowns（非法值收敛，不阻塞启动）
  if (s?.personalityV2?.relationship) {
    for (const k of ['casualCooldownMs', 'positiveCooldownMs']) {
      if (s.personalityV2.relationship[k] !== undefined) {
        const v = clamp(`socialV2.personalityV2.relationship.${k}`, s.personalityV2.relationship[k], 0, 86400000, { errors, warnings }, { integer: true });
        if (v !== undefined) s.personalityV2.relationship[k] = v;
      }
    }
  }

  // harassment / queue
  if (s?.harassment) {    if (s.harassment.decayPerMin !== undefined) {
      const d = num(s.harassment.decayPerMin);
      if (d === null || d < 0) errors.push(`socialV2.harassment.decayPerMin 必须是非负数字（实际：${JSON.stringify(s.harassment.decayPerMin)}）`);
    }
    const th = clamp('socialV2.harassment.muteThreshold', s.harassment.muteThreshold ?? 8, 1, 10, { errors, warnings }, { integer: true });
    if (th !== undefined) s.harassment.muteThreshold = th;
    const min = clamp('socialV2.harassment.muteMinutes', s.harassment.muteMinutes ?? 30, 1, 240, { errors, warnings }, { integer: true });
    if (min !== undefined) s.harassment.muteMinutes = min;
  }
  if (s?.queue) {
    for (const k of ['nightStartHour', 'nightEndHour']) {
      if (s.queue[k] !== undefined) {
        const n = num(s.queue[k]);
        if (n === null || n < 0 || n > 24) errors.push(`socialV2.queue.${k} 必须在 0..24（实际：${JSON.stringify(s.queue[k])}）`);
      }
    }
    for (const k of ['softTtlMs', 'explicitTtlMs']) {
      if (s.queue[k] !== undefined) {
        const v = clamp(`socialV2.queue.${k}`, s.queue[k], 1000, 3600000, { errors, warnings }, { integer: true });
        if (v !== undefined) s.queue[k] = v;
      }
    }
  }

  // silentConversations
  if (s?.silentConversations !== undefined) {
    if (!Array.isArray(s.silentConversations)) errors.push('socialV2.silentConversations 必须是数组');
    else {
      const bad = s.silentConversations.filter((x) => !/^(group|private):\d+$/.test(String(x)));
      if (bad.length) errors.push(`silentConversations 含非法会话键：${JSON.stringify(bad.slice(0, 3))}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, sanitized: out };
}
