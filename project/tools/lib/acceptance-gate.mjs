// 验收门禁判定（F09）：把"哪些项算失败"从脚本里抽出来，便于注入测试。
//
// 规则：
//   · 普通检查失败 → 失败；
//   · readiness 失败默认也算失败（核心依赖不健康）；
//   · --allow-degraded 时 readiness 失败只降级、不进失败列表；
//   · readiness 探测失败/JSON 解析失败（ok=false 且无 checks）同样算失败。

export function computeFailureList(results, { allowDegraded = false } = {}) {
  const list = Array.isArray(results) ? results : [];
  const fails = [];
  for (const r of list) {
    if (!r || r.ok === true) continue;
    if (r.label === 'readiness') {
      if (allowDegraded) continue;
      fails.push({ label: 'readiness', detail: r.detail || '核心依赖不健康' });
      continue;
    }
    fails.push({ label: r.label, detail: r.detail || '' });
  }
  return fails;
}

/** 退出码：有失败即 1。 */
export function exitCodeFor(results, opts) {
  return computeFailureList(results, opts).length ? 1 : 0;
}
