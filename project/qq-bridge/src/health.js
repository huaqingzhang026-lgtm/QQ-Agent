// 健康判定（S5.3）：把"端口活着"升级成"依赖真的可用"。
//
// 三类检查：
//   · liveness：进程/端口在
//   · readiness：状态已加载（DSH 初始化完成、SnowLuma 已登录）
//   · dependency：QQ / DSH / MCP 各自能否响应
//
// 本模块只做纯判定，实际探测在 tools/readiness.mjs 里。

/** 单项检查：{ name, ok, detail, required } */
export function summarize(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failed = list.filter((c) => c && c.required !== false && c.ok !== true);
  return {
    ok: failed.length === 0,
    total: list.length,
    failed: failed.map((c) => c.name),
    degraded: list.filter((c) => c && c.ok !== true && c.required === false).map((c) => c.name),
    checks: list,
  };
}

/** 把探测结果转成"该不该重启某个任务"的建议。 */
export function suggestActions(result, { cooldownMs = 600000, lastRestart = {}, now = Date.now() } = {}) {
  const actions = [];
  for (const c of result?.checks ?? []) {
    if (!c || c.ok === true) continue;
    if (!c.task) continue;
    const last = Number(lastRestart[c.task] || 0);
    if (now - last < cooldownMs) {
      actions.push({ task: c.task, action: 'skip', reason: 'cooldown', name: c.name });
    } else {
      actions.push({ task: c.task, action: 'restart', reason: c.detail || 'unhealthy', name: c.name });
    }
  }
  return actions;
}
