// 验收运行器：把"能不能交付"变成一条命令。
//
//   node tools/acceptance.mjs            # 跑全部检查并写 docs/refactor/acceptance-latest.md
//   node tools/acceptance.mjs --json     # 只输出 JSON
//
// 检查项：
//   1. 全部回放套件（tools/replay/*.test.mjs）
//   2. 人格源与生成物一致（persona-build --check）
//   3. 配置校验（config-schema）
//   4. 运行时 readiness（端口 + QQ 登录 + DSH 初始化 + 桥接链路）
//   5. 状态文件版本（social-v2 schemaVersion/revision）
//
// 任何 FAIL → 退出码 1；GAP/MANUAL 不算失败，但会在报告里单列。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFailureList } from './lib/acceptance-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const OUT_MD = path.join(ROOT, 'docs', 'refactor', 'acceptance-latest.md');

const suites = fs.readdirSync(path.join(ROOT, 'tools', 'replay'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

const results = [];
function run(label, args, { parse } = {}) {
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const last = out.trim().split('\n').filter(Boolean).pop() ?? '';
  const ok = r.status === 0;
  const extra = parse ? parse(out) : {};
  results.push({ label, ok, detail: last.slice(0, 200), ...extra });
  return { ok, out };
}

// 1. 回放
for (const f of suites) run(f.replace('.test.mjs', ''), [path.join('tools', 'replay', f)]);

// 2. 人格一致性
run('persona-build --check', [path.join('tools', 'persona-build.mjs'), '--check']);

// 3. 配置校验
run('config-schema', [path.join('tools', 'replay', 'config-schema.test.mjs')]);

// 4. readiness
const ready = run('readiness', [path.join('tools', 'readiness.mjs'), '--json'], {
  parse: (out) => {
    try {
      const j = JSON.parse(out.slice(out.indexOf('{')));
      return { degraded: j.degraded ?? [], failed: j.failed ?? [] };
    } catch { return {}; }
  },
});

// 5. 状态文件版本
const stateFile = path.join(ROOT, 'qq-bridge', 'state', 'social-v2.json');
let stateInfo = { ok: false, detail: 'missing' };
try {
  const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  stateInfo = { ok: typeof j.schemaVersion === 'number' && typeof j.revision === 'number', detail: `schemaVersion=${j.schemaVersion} revision=${j.revision}` };
} catch (e) { stateInfo = { ok: false, detail: String(e.message).slice(0, 80) }; }
results.push({ label: 'state-file (social-v2)', ...stateInfo });

// 汇总
const matrix = results.find((r) => r.label === 'regression-matrix');
const mem = results.find((r) => r.label === 'memory-eval');
const allowDegraded = process.argv.includes('--allow-degraded');
// F09：readiness 失败默认计入失败；只有显式 --allow-degraded 才放行降级。
const fails = computeFailureList(results, { allowDegraded });
const readyFailed = (ready.ok ? [] : results.find((r) => r.label === 'readiness')?.failed ?? []);
const degraded = (results.find((r) => r.label === 'readiness')?.degraded ?? []);

const summary = {
  at: new Date().toISOString(),
  suites: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: fails.map((r) => r.label),
  matrix: matrix?.detail ?? '',
  memory: mem?.detail ?? '',
  readinessFailed: readyFailed,
  readinessDegraded: degraded,
  results,
};

const md = [
  '# 验收报告（自动生成）',
  '',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
  '',
  '## 结果',
  '',
  `- 检查项：${summary.suites}`,
  `- 通过：${summary.passed}`,
  `- 失败：${summary.failed.length ? summary.failed.join('、') : '无'}`,
  `- 回归矩阵：${summary.matrix || '（未运行）'}`,
  `- 记忆评测：${summary.memory || '（未运行）'}`,
  `- readiness 失败项：${readyFailed.length ? readyFailed.join('、') : '无'}`,
  `- readiness 降级项：${degraded.length ? degraded.join('、') : '无'}`,
  '',
  '## 明细',
  '',
  '| 检查 | 结果 | 摘要 |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.label} | ${r.ok ? '✅' : '❌'} | ${String(r.detail).replace(/\|/g, '/')} |`),
  '',
  '## 说明',
  '',
  '- GAP / MANUAL 项不算失败：它们是**已识别但未实现/需实机**的能力，明细见 `behavior-spec.md` 与 `verification.md`。',
  '- 本报告只证明"隔离环境与静态检查通过"，不等于线上观察期结论。',
  '',
].join('\n');

fs.writeFileSync(OUT_MD, md, 'utf8');
if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(md.split('\n').slice(0, 20).join('\n'));
  console.log(`\n完整报告：${path.relative(ROOT, OUT_MD)}`);
}
process.exit(fails.length ? 1 : 0);
