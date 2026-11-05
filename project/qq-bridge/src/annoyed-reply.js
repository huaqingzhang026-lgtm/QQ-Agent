// 敷衍回复（@ 时按概率回一句"烦/不想回"的态度话，不叫模型）。
//
// 规则（2026-10-23 调整）：
//   · **默认对所有群生效**（allGroups=true），概率 10%；
//   · 说的是"态度"而不是固定某一句：从态度句池里挑，且不连续两次同一句；
//   · 有最小间隔（默认 5 分钟），避免每个 @ 都敷衍；
//   · 纯函数，随机源可注入，便于回放。

const DEFAULT_LINES = [
  '有点烦了',
  '不想回，别催',
  '烦死了，等会说',
  '现在不想理人',
  '让我静一会儿',
  '知道了，别一直问',
  '你好烦啊',
  '不想说话',
  '看心情吧',
  '懒得回',
  '消息太多了…',
  '又来了',
  '能不能让我歇会儿',
  '晚点再说，现在烦',
];

export function normalizeAnnoyedConfig(cfg, key) {
  const all = cfg?.socialV2?.annoyedReply ?? {};
  if (all.enabled === false) return null;
  const g = (all.groups ?? {})[key];
  const useAll = all.allGroups === true || (all.allGroups !== false && all.probability !== undefined);
  const src = g && g.enabled !== false ? g : (useAll ? all : null);
  if (!src) return null;
  const lines = Array.isArray(src.lines) && src.lines.length ? src.lines.map(String).slice(0, 30) : DEFAULT_LINES;
  return {
    probability: Math.min(1, Math.max(0, Number(src.probability ?? all.probability) || 0)),
    minIntervalMs: Math.max(0, Number(src.minIntervalMs ?? all.minIntervalMs) || 0),
    lines,
  };
}

/**
 * 决定这次 @ 是否用敷衍回复，并挑一句"态度话"。
 * @returns {{send: boolean, line: string, reason: string}}
 */
export function pickAnnoyedReply({ cfg, key, lastAt = 0, lastLine = '', now = Date.now(), random = Math.random }) {
  const c = normalizeAnnoyedConfig(cfg, key);
  if (!c) return { send: false, line: '', reason: 'disabled' };
  if (c.probability <= 0) return { send: false, line: '', reason: 'zero-probability' };
  if (c.minIntervalMs > 0 && now - Number(lastAt || 0) < c.minIntervalMs) {
    return { send: false, line: '', reason: 'cooldown' };
  }
  const roll = Number(random());
  if (!Number.isFinite(roll) || roll >= c.probability) return { send: false, line: '', reason: 'miss' };
  // 不连续两次同一句：把上次那句排除后再挑
  const pool = c.lines.length > 1 ? c.lines.filter((x) => x !== lastLine) : c.lines;
  const i = Math.floor(Number(random()) * pool.length) % pool.length;
  const line = pool[Math.max(0, Math.min(pool.length - 1, i))] ?? pool[0];
  return { send: true, line, reason: 'hit' };
}
