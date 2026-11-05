// 聊天模型路由：Astra → 6.1 Sol → DeepSeek；10 秒无输出降级；最后 MiMo 兜底。
//
// 只负责"选哪条链"和"超时/错误该不该降级"，不做 IO。

export const DEFAULT_CHAIN = [
  { provider: 'jojo', model: 'gpt-6-astra' },
  { provider: 'jojo', model: 'gpt-6.1-sol' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
];

export function normalizeRouting(cfg) {
  const r = cfg?.socialV2?.modelRouting ?? cfg?.modelRouting ?? {};
  const chain = Array.isArray(r.chain) && r.chain.length ? r.chain : DEFAULT_CHAIN;
  return {
    enabled: r.enabled !== false,
    firstOutputTimeoutMs: Number.isFinite(Number(r.firstOutputTimeoutMs)) ? Math.max(1000, Number(r.firstOutputTimeoutMs)) : 10000,
    chain: chain.map((x) => ({ provider: String(x.provider || ''), model: String(x.model || '') })).filter((x) => x.provider && x.model),
    mimoFallback: r.mimoFallback !== false,
    timeoutDowngrade: r.timeoutDowngrade === true,
    taskChains: r.taskChains && typeof r.taskChains === 'object' ? r.taskChains : {},
  };
}

/** 内部任务（黑话学习/心跳/复盘）不值得用贵模型。 */
export function isInternalKey(key) {
  const k = String(key || '');
  return k.startsWith('internal:') || k === 'heartbeat' || k === 'review' || k.startsWith('browse');
}

/** 该会话使用的模型链。 */
export function chainForKey(key, cfg) {
  const r = normalizeRouting(cfg);
  if (!r.enabled) return [];
  if (isInternalKey(key)) return [{ provider: 'deepseek-account', model: 'deepseek-flash' }];
  return r.chain;
}

/** 按任务选链：chat / code / summary；没有配置时回落到主链。 */
export function chainForTask(key, cfg, task = 'chat') {
  const r = normalizeRouting(cfg);
  if (!r.enabled) return [];
  if (isInternalKey(key)) return [{ provider: 'deepseek-account', model: 'deepseek-flash' }];
  const raw = Array.isArray(r.taskChains?.[task]) && r.taskChains[task].length ? r.taskChains[task] : r.chain;
  return raw.map((x) => ({ provider: String(x.provider || ''), model: String(x.model || '') })).filter((x) => x.provider && x.model);
}

/** 超时/错误后是否还有下一档。 */
export function nextModel(chain, index) {
  return index + 1 < chain.length ? chain[index + 1] : null;
}


// ── 每日预算（MAX 包月：CodexPlus 价，单位元/百万 token）────────────────────
export const MAX_PRICES = {
  'gpt-6-astra': { input: 1.7, output: 8.5 },
  'gpt-6.1-sol': { input: 0.34, output: 1.7 },
};

export function budgetConfig(cfg) {
  const b = cfg?.socialV2?.modelRouting?.dailyBudget ?? {};
  return {
    limitYuan: Number(b.limitYuan) || 100,
    downgradeAtYuan: Number(b.downgradeAtYuan) || 70,
    hardStopAtLimit: b.hardStopAtLimit !== false,
    prices: { ...MAX_PRICES, ...(b.prices ?? {}) },
  };
}

/** 今日 jojo 的保守花费：所有输入 token 都按输入价（不假设缓存折扣）。 */
export function spendOfRows(rows, dayStart) {
  let yuan = 0;
  for (const r of rows) {
    if (!r || r.t < dayStart || r.provider !== 'jojo') continue;
    // base 是会话累计快照（可能含前几天的历史），预算只认 turn 增量，避免重复计费。
    if (r.k !== 'turn') continue;
    const p = MAX_PRICES[r.model];
    if (!p) continue;
    const miss = Number(r.b?.cacheMiss) || 0;
    const hit = Number(r.b?.cacheHit) || 0;
    const out = (Number(r.b?.output) || 0) + (Number(r.b?.reasoning) || 0);
    yuan += ((miss + hit) / 1e6) * p.input + (out / 1e6) * p.output;
  }
  return yuan;
}

/** 预算后的链：<70 Astra；≥70 去掉 Astra；≥100 只留 deepseek。 */
export function applyBudget(chain, spentYuan, cfg) {
  const b = budgetConfig(cfg);
  if (spentYuan >= b.limitYuan && b.hardStopAtLimit) {
    return [{ provider: 'deepseek-account', model: 'deepseek-flash' }];
  }
  if (spentYuan >= b.downgradeAtYuan) {
    return chain.filter((x) => x.model !== 'gpt-6-astra');
  }
  return chain;
}
