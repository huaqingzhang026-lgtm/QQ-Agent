// 可注入的 clock / random / modelAdapter 骨架。
// 人格状态模块（后续 A02+）必须通过这些注入点获取时间、随机与模型结果，
// 测试才能在不碰系统时钟、不调用真实模型的前提下做确定性断言。

export function createClock(startMs = 1_760_000_000_000) {
  let now = Number(startMs);
  return {
    nowMs: () => now,
    nowIso: () => new Date(now).toISOString(),
    set(ms) { now = Number(ms); return now; },
    advance(ms) { now += Number(ms); return now; },
  };
}

// 确定性伪随机（mulberry32），便于重复采样。
export function createRandom(seed = 0x9e3779b9) {
  let a = Number(seed) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.seed = seed;
  return next;
}

// 模型适配器骨架：默认返回固定候选，记录每次调用，不发起任何模型请求。
export function createModelAdapter(defaultReply = '（mock 模型输出）') {
  const calls = [];
  return {
    calls,
    async produce(request) {
      calls.push({ at: new Date().toISOString(), request: JSON.parse(JSON.stringify(request ?? null)) });
      return { ok: true, text: defaultReply, mocked: true, callIndex: calls.length };
    },
  };
}
