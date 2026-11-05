#!/usr/bin/env node
// A00-rework1 统一离线测试入口（B01 路径预检 + B02 子进程 I/O 隔离 + B03 变化门禁）。
//
// 用法：
//   node tools/personality-tests/run.mjs --offline --data-root <临时目录> --report <证据目录> \
//     [--manifest <用例清单>] [--forbid-root <绝对路径>]... [--protect-root <目录>]... \
//     [--allow-endpoint <host:port>]... [--write-root <dataRoot 内子目录>]... \
//     [--filter <子串>] [--list]
//
// 关键语义（见 evidence/isolation/design.md）：
//   - 任何 mkdir/write/spawn 之前完成全部路径预检；预检失败 => 0 执行、不创建 dataRoot。
//     错误报告只写“已独立验证安全”的 report 目录；report 本身不安全时仅 stderr。
//   - 子进程以 `node --import isolation/preload.mjs` 启动；NODE_OPTIONS 递归注入 node 孙进程。
//     preload 默认拒绝 dataRoot/report/TEMP/登记 writeRoots 之外的写入与未登记网络连接。
//   - 运行前后快照 protected roots；新增/修改/删除/不可读 => 门禁失败并列出变化。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveRealTarget, isInside, samePath, overlaps, classifyArg, productionLauncherKind,
  isValidCaseId, parseEndpoint, isDirectory, relat, toPosix,
} from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_ROOT = path.resolve(HERE, '..', '..');
const RUNNER_FILE = fileURLToPath(import.meta.url);
const RUNNER_VERSION = 'A00-rework2';
const DEFAULT_MANIFEST = path.join(HERE, 'cases.baseline.json');
const PRELOAD_FILE = path.join(HERE, 'isolation', 'preload.mjs');
const PATHS_LIB_FILE = path.join(HERE, 'lib', 'paths.mjs');
const DEFAULT_LIVE_ROOT = 'C:/QQ-Agent/project';

const CANDIDATE_PROTECTED = [
  'qq-bridge/src', 'qq-bridge/scripts', 'qq-bridge/dsh', 'qq-bridge/plugins',
  'qq-bridge/state', 'agent-home',
];
const LIVE_PROTECTED = [
  'qq-bridge/src', 'qq-bridge/scripts', 'qq-bridge/dsh', 'qq-bridge/plugins',
  'qq-bridge/config.json', 'tools',
];
// 线上常驻进程持续写入的运行时目录：B03 不纳入失败门禁（单列说明，见需求/Lead 说明）。
const LIVE_RUNTIME_EXCLUDED = ['state', 'agent-home', 'dsh-home', 'memory-mcp', 'qq-bridge/state', 'qq-bridge/agent-home'];
const LIVE_RUNTIME_FILE = /\.(log|log\.[^/]+|tmp|lock)$/i;
const LIVE_RUNTIME_BASENAMES = new Set(['keepalive-state.json']);

const nowIso = () => new Date().toISOString();
const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (file) => sha256Buffer(fs.readFileSync(file));
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const readJson = (file) => JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));

function parseArgs(argv) {
  const args = {
    offline: false, list: false, help: false,
    forbidRoots: [], protectRoots: [], allowEndpoints: [], writeRoots: [],
  };
  const value = (i, a) => {
    const v = argv[i];
    if (v === undefined) throw new Error(`参数 ${a} 缺少值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') args.offline = true;
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--data-root') args.dataRoot = value(++i, a);
    else if (a === '--report') args.report = value(++i, a);
    else if (a === '--manifest') args.manifest = value(++i, a);
    else if (a === '--forbid-root') args.forbidRoots.push(value(++i, a));
    else if (a === '--protect-root') args.protectRoots.push(value(++i, a));
    else if (a === '--allow-endpoint') args.allowEndpoints.push(value(++i, a));
    else if (a === '--write-root') args.writeRoots.push(value(++i, a));
    else if (a === '--filter') args.filter = value(++i, a);
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

function printHelp() {
  console.log([
    'A00-rework1 personality-tests runner',
    '',
    '必填：--offline --data-root <dir> --report <dir>',
    '可选：--manifest <json> --forbid-root <path>(可重复) --protect-root <path>(可重复)',
    '      --allow-endpoint <host:port>(可重复) --write-root <dataRoot 子目录>(可重复)',
    '      --filter <substr> --list',
  ].join('\n'));
}

function killTree(pid) {
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* ignore */ }
}

// ── 预检 ─────────────────────────────────────────────────────────────────────
function resolveSpec(raw, label) {
  const resolved = resolveRealTarget(fs, raw);
  return {
    label,
    input: raw,
    declared: resolved.declared,
    real: resolved.real,
    existed: resolved.existed,
    invalid: resolved.invalid,
  };
}

function buildProtectedSpecs(args) {
  const specs = [];
  for (const rel of CANDIDATE_PROTECTED) {
    specs.push({ label: `candidate:${rel}`, declared: path.join(CANDIDATE_ROOT, rel), live: false, auto: true });
  }
  for (const rel of LIVE_PROTECTED) {
    specs.push({ label: `live:${rel}`, declared: path.join(DEFAULT_LIVE_ROOT, rel), live: true, auto: true });
  }
  for (const raw of args.protectRoots) {
    const resolved = path.resolve(raw);
    specs.push({ label: `explicit:${relat(process.cwd(), resolved)}`, declared: resolved, live: false, explicit: true });
  }
  return specs;
}

function buildForbiddenSpecs(args) {
  return [
    { label: 'live-read-only', declared: path.resolve(DEFAULT_LIVE_ROOT), builtin: true },
    ...args.forbidRoots.map((raw) => ({ label: `explicit:${raw}`, declared: path.resolve(raw), builtin: false })),
  ];
}

function validateEndpointList(args) {
  const endpoints = [];
  const violations = [];
  for (const text of args.allowEndpoints) {
    const parsed = parseEndpoint(text);
    if (!parsed) violations.push({ check: 'allow-endpoint', target: text, reason: 'bad-format（期望 host:port）' });
    else endpoints.push(parsed);
  }
  return { endpoints, violations };
}

function normalizeCases(manifest) {
  const rawCases = Array.isArray(manifest?.cases) ? manifest.cases : [];
  return rawCases.map((raw) => {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
      raw: c,
      id: typeof c.id === 'string' ? c.id : null,
      name: typeof c.name === 'string' ? c.name : (typeof c.id === 'string' ? c.id : '(未命名)'),
      script: typeof c.script === 'string' ? c.script : null,
      args: Array.isArray(c.args) ? c.args : [],
      cwd: typeof c.cwd === 'string' ? c.cwd : null,
      required: c.required !== false,
      skip: Boolean(c.skip),
      skipReason: typeof c.skipReason === 'string' ? c.skipReason : null,
      category: c.category ?? null,
      timeoutMs: Number.isFinite(Number(c.timeoutMs)) ? Number(c.timeoutMs) : null,
      writeRoots: Array.isArray(c.writeRoots) ? c.writeRoots : [],
      allowEndpoints: Array.isArray(c.allowEndpoints) ? c.allowEndpoints : [],
      expectViolations: c.expectViolations === true,
      expectViolationsReason: typeof c.expectViolationsReason === 'string' ? c.expectViolationsReason : null,
    };
  });
}

// 纯读取预检：只做路径解析与规则判定，不做任何 mkdir/write/spawn。
function computePreflight({ args, manifestPath, cases, manifestError }) {
  const violations = [];
  const inputs = [];
  const outputs = [];
  const resolved = {
    dataRoot: null, report: null, policyDir: null, violationsFile: null, selfPortsFile: null,
    forbidRoots: [], protectedRoots: [], endpoints: [], mappedCases: [],
  };
  const pushViolation = (entry) => violations.push(entry);

  // 1) 根目录解析
  for (const spec of buildForbiddenSpecs(args)) {
    const r = resolveSpec(spec.declared, spec.label);
    if (r.invalid || !r.real) pushViolation({ check: 'forbidden-root', target: spec.declared, reason: r.invalid ?? 'unresolvable' });
    resolved.forbidRoots.push({ ...spec, ...r });
  }
  for (const spec of buildProtectedSpecs(args)) {
    const r = resolveSpec(spec.declared, spec.label);
    if (r.invalid || !r.real) pushViolation({ check: 'protected-root', target: spec.declared, reason: r.invalid ?? 'unresolvable' });
    resolved.protectedRoots.push({ ...spec, ...r });
  }

  // 2) endpoint
  const endpointInfo = validateEndpointList(args);
  resolved.endpoints = endpointInfo.endpoints;
  violations.push(...endpointInfo.violations);

  // 3) 必填输出
  if (!args.dataRoot) pushViolation({ check: 'data-root-required', target: '--data-root', reason: '缺少 --data-root' });
  else {
    const r = resolveSpec(args.dataRoot, 'dataRoot');
    resolved.dataRoot = r;
    outputs.push({ label: 'dataRoot', ...r });
    if (r.invalid || !r.real) pushViolation({ check: 'data-root-resolve', target: args.dataRoot, reason: r.invalid ?? 'unresolvable' });
    else if (r.existed && !isDirectory(fs, r.declared)) pushViolation({ check: 'data-root-type', target: r.declared, reason: 'dataRoot 已存在但不是目录' });
  }
  if (!args.report) pushViolation({ check: 'report-dir-required', target: '--report', reason: '缺少 --report' });
  else {
    const r = resolveSpec(args.report, 'report');
    resolved.report = r;
    outputs.push({ label: 'report', ...r });
    if (r.invalid || !r.real) pushViolation({ check: 'report-resolve', target: args.report, reason: r.invalid ?? 'unresolvable' });
    else if (r.existed && !isDirectory(fs, r.declared)) pushViolation({ check: 'report-type', target: r.declared, reason: 'report 已存在但不是目录' });
  }

  if (resolved.dataRoot?.real) {
    resolved.policyDir = { ...resolveSpec(path.join(resolved.dataRoot.real, 'policy'), 'policyDir') };
    resolved.violationsFile = path.join(resolved.policyDir.real ?? path.join(resolved.dataRoot.real, 'policy'), 'violations.jsonl');
    resolved.selfPortsFile = path.join(resolved.policyDir.real ?? path.join(resolved.dataRoot.real, 'policy'), 'self-ports.jsonl');
  }

  // 4) dataRoot / report 互斥
  if (resolved.dataRoot?.real && resolved.report?.real) {
    if (overlaps(resolved.dataRoot.real, resolved.report.real)) {
      pushViolation({ check: 'data-root-report-overlap', dataRoot: resolved.dataRoot.real, report: resolved.report.real, reason: 'dataRoot 与 report 不得相同或互相包含' });
    }
  }

  // 5) 输出不得落在 forbidden / protected
  for (const output of outputs) {
    if (!output.real) continue;
    const forbidden = resolved.forbidRoots.find((f) => f.real && isInside(f.real, output.real));
    if (forbidden) pushViolation({ check: 'forbidden-output', target: output.declared, root: forbidden.declared, reason: `输出落在 forbidden root（${forbidden.label}）内` });
    const protectedRoot = resolved.protectedRoots.find((p) => p.real && isInside(p.real, output.real));
    if (protectedRoot) pushViolation({ check: 'protected-output', target: output.declared, root: protectedRoot.declared, reason: `输出落在 protected root（${protectedRoot.label}）内` });
  }

  // 6) --write-root / policy 目录
  resolved.writeRoots = [];
  for (const raw of args.writeRoots) {
    const r = resolveSpec(raw, `write-root:${raw}`);
    resolved.writeRoots.push(r);
    if (!resolved.dataRoot?.real) continue;
    if (!r.real || r.invalid) pushViolation({ check: 'write-root-invalid', target: raw, reason: r.invalid ?? 'unresolvable' });
    else if (!isInside(resolved.dataRoot.real, r.real)) pushViolation({ check: 'write-root-outside-data-root', target: raw, real: r.real, dataRoot: resolved.dataRoot.real });
  }

  // 7) manifest（读取已发生；此处校验位置与输入输出同源）
  const manifestReal = resolveSpec(manifestPath, 'manifest');
  inputs.push({ label: 'manifest', ...manifestReal });
  if (manifestReal.real) {
    const forbidden = resolved.forbidRoots.find((f) => f.real && isInside(f.real, manifestReal.real));
    if (forbidden) pushViolation({ check: 'manifest-in-forbidden', target: manifestPath, root: forbidden.declared });
  }

  // 8) 逐用例校验（即使被 --filter 排除也校验，生产启动器不得静默跳过）
  const seenIds = new Set();
  for (const [index, c] of cases.entries()) {
    const caseLabel = c.id ?? `#${index}`;
    if (!c.id) { pushViolation({ check: 'case-id', case: caseLabel, reason: '缺少字符串 id' }); continue; }
    if (!isValidCaseId(c.id)) pushViolation({ check: 'case-id', case: caseLabel, id: c.id, reason: 'id 不合法（日志文件名安全）' });
    if (seenIds.has(c.id.toLowerCase())) pushViolation({ check: 'case-id-duplicate', case: caseLabel, id: c.id });
    seenIds.add(c.id.toLowerCase());
    if (!c.script) { pushViolation({ check: 'case-script', case: caseLabel, reason: '缺少字符串 script' }); continue; }
    if (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string')) pushViolation({ check: 'case-args', case: caseLabel, reason: 'args 必须是字符串数组' });
    if (c.writeRoots.some((a) => typeof a !== 'string')) pushViolation({ check: 'case-write-roots', case: caseLabel, reason: 'writeRoots 必须是字符串数组' });

    const scriptRaw = path.resolve(CANDIDATE_ROOT, c.script);
    const script = resolveSpec(scriptRaw, `script:${caseLabel}`);
    if (script.invalid || !script.real) pushViolation({ check: 'case-script-resolve', case: caseLabel, target: scriptRaw, reason: script.invalid ?? 'unresolvable' });
    const launcher = productionLauncherKind(c.script) ?? (script.real ? productionLauncherKind(script.real) : null);
    if (launcher) pushViolation({ check: 'production-launcher', case: caseLabel, target: c.script, kind: launcher, reason: 'manifest 中出现生产启动器，拒绝运行' });
    if (script.real) {
      const forbidden = resolved.forbidRoots.find((f) => f.real && isInside(f.real, script.real));
      if (forbidden) pushViolation({ check: 'forbidden-script', case: caseLabel, target: scriptRaw, root: forbidden.declared });
      const explicitProtected = resolved.protectedRoots.find((p) => p.explicit && p.real && isInside(p.real, script.real));
      if (explicitProtected) pushViolation({ check: 'protected-script', case: caseLabel, target: scriptRaw, root: explicitProtected.declared });
      inputs.push({ label: `script:${caseLabel}`, ...script });
    }

    const cwdRaw = path.resolve(CANDIDATE_ROOT, c.cwd ?? '.');
    const cwd = resolveSpec(cwdRaw, `cwd:${caseLabel}`);
    if (cwd.invalid || !cwd.real) pushViolation({ check: 'case-cwd-resolve', case: caseLabel, target: cwdRaw, reason: cwd.invalid ?? 'unresolvable' });
    else {
      if (!isDirectory(fs, cwdRaw)) pushViolation({ check: 'case-cwd-missing', case: caseLabel, target: cwdRaw, reason: 'cwd 不存在或不是目录' });
      const forbidden = resolved.forbidRoots.find((f) => f.real && isInside(f.real, cwd.real));
      if (forbidden) pushViolation({ check: 'forbidden-cwd', case: caseLabel, target: cwdRaw, root: forbidden.declared });
      const protectedRoot = resolved.protectedRoots.find((p) => p.real && isInside(p.real, cwd.real));
      if (protectedRoot) pushViolation({ check: 'protected-cwd', case: caseLabel, target: cwdRaw, root: protectedRoot.declared });
    }

    // args 里像路径的参数
    for (const [argIndex, arg] of c.args.entries()) {
      const classified = classifyArg(arg);
      let candidatePath = null;
      if (classified.kind === 'absolute-path') candidatePath = arg;
      else if (classified.kind === 'relative-path') candidatePath = path.resolve(cwdRaw, arg);
      else if (classified.kind === 'other' && fs.existsSync(path.resolve(cwdRaw, arg))) candidatePath = path.resolve(cwdRaw, arg);
      if (!candidatePath) {
        const launcherArg = productionLauncherKind(arg);
        if (launcherArg) pushViolation({ check: 'production-launcher-arg', case: caseLabel, argIndex, target: arg, kind: launcherArg });
        continue;
      }
      const argLauncher = productionLauncherKind(arg) ?? productionLauncherKind(candidatePath);
      if (argLauncher) pushViolation({ check: 'production-launcher-arg', case: caseLabel, argIndex, target: arg, kind: argLauncher });
      const argPath = resolveSpec(candidatePath, `arg:${caseLabel}:${argIndex}`);
      if (argPath.invalid) continue;
      if (argPath.real) {
        const forbidden = resolved.forbidRoots.find((f) => f.real && isInside(f.real, argPath.real));
        if (forbidden) pushViolation({ check: 'forbidden-arg', case: caseLabel, argIndex, target: candidatePath, root: forbidden.declared });
        const explicitProtected = resolved.protectedRoots.find((p) => p.explicit && p.real && isInside(p.real, argPath.real));
        if (explicitProtected) pushViolation({ check: 'protected-arg', case: caseLabel, argIndex, target: candidatePath, root: explicitProtected.declared });
      }
    }

    // 用例级 writeRoots 只允许 dataRoot 内子目录
    const caseWriteRoots = [];
    for (const raw of c.writeRoots) {
      const r = resolveSpec(path.resolve(resolved.dataRoot?.real ?? CANDIDATE_ROOT, raw), `case-write-root:${caseLabel}`);
      caseWriteRoots.push(r);
      if (!resolved.dataRoot?.real) continue;
      if (!r.real || r.invalid) pushViolation({ check: 'case-write-root-invalid', case: caseLabel, target: raw });
      else if (!isInside(resolved.dataRoot.real, r.real)) pushViolation({ check: 'case-write-root-outside-data-root', case: caseLabel, target: raw, real: r.real, dataRoot: resolved.dataRoot.real });
    }
    // 用例级 endpoints
    const caseEndpoints = [];
    for (const raw of c.allowEndpoints) {
      if (typeof raw !== 'string') { pushViolation({ check: 'case-endpoint', case: caseLabel, reason: 'allowEndpoints 必须是字符串数组' }); continue; }
      const parsed = parseEndpoint(raw);
      if (!parsed) pushViolation({ check: 'case-endpoint', case: caseLabel, target: raw, reason: 'bad-format' });
      else caseEndpoints.push(parsed);
    }

    // 日志文件路径（id 已校验；这里再做最终真实目标检查）
    if (resolved.report?.real) {
      const logPath = path.join(resolved.report.real, `${c.id}.log`);
      const logResolved = resolveSpec(logPath, `log:${caseLabel}`);
      if (logResolved.invalid) pushViolation({ check: 'case-log-resolve', case: caseLabel, target: logPath, reason: logResolved.invalid });
    }

    resolved.mappedCases.push({
      caseId: c.id,
      scriptRaw,
      scriptReal: script.real ?? null,
      cwdRaw,
      cwdReal: cwd.real ?? null,
      writeRoots: caseWriteRoots.map((r) => r.real).filter(Boolean),
      endpoints: caseEndpoints,
    });
  }

  // 9) 输入/输出同源（含别名 realpath 后相同或包含）
  for (const output of outputs) {
    if (!output.real) continue;
    for (const input of inputs) {
      if (!input.real) continue;
      if (samePath(output.real, input.real)) {
        pushViolation({ check: 'input-output-same', output: output.label, target: output.declared, input: input.label, inputPath: input.declared });
      } else if (isInside(output.real, input.real) || isInside(input.real, output.real)) {
        pushViolation({ check: 'input-output-overlap', output: output.label, target: output.declared, input: input.label, inputPath: input.declared });
      }
    }
  }

  const manifestLoaded = Boolean(!manifestError);
  const ok = violations.length === 0 && manifestLoaded && Boolean(args.offline) && Boolean(args.dataRoot) && Boolean(args.report);
  return { ok, violations, resolved, inputs, outputs, manifestLoaded, manifestError };
}

// 预检失败时的安全错误报告落点：只有独立验证为安全才允许写。
function safeErrorReportDestination({ args, preflight }) {
  if (!args.report) return null;
  const report = resolveSpec(args.report, 'report');
  if (!report.real || report.invalid) return null;
  if (report.existed && !isDirectory(fs, report.declared)) return null;
  const forbidRoots = preflight?.resolved?.forbidRoots ?? [];
  const protectedRoots = preflight?.resolved?.protectedRoots ?? [];
  const dataRoot = preflight?.resolved?.dataRoot ?? null;
  if (forbidRoots.some((f) => f.real && isInside(f.real, report.real))) return null;
  if (protectedRoots.some((p) => p.real && isInside(p.real, report.real))) return null;
  if (dataRoot?.real && overlaps(dataRoot.real, report.real)) return null;
  const inputs = preflight?.inputs ?? [];
  if (inputs.some((i) => i.real && overlaps(i.real, report.real))) return null;
  return { ...report, file: path.join(report.declared, 'preflight-failure.json') };
}

function tryWriteFailureReport({ args, preflight, gates, manifestPath, cases }) {
  const destination = safeErrorReportDestination({ args, preflight });
  const failure = {
    schemaVersion: 2,
    suite: 'personality-tests-baseline',
    runnerVersion: RUNNER_VERSION,
    phase: 'preflight',
    generatedAt: nowIso(),
    runner: {
      path: RUNNER_FILE, sha256: sha256File(RUNNER_FILE), version: RUNNER_VERSION,
      node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch,
    },
    manifest: { path: manifestPath, error: preflight?.manifestError ?? null },
    preflight: {
      ok: false,
      violations: preflight?.violations ?? [],
    },
    gates,
    counts: { manifest: cases.length, executed: 0, passed: 0, failed: 0, timeout: 0, loadFailure: 0, skipped: 0, requiredSkipped: 0 },
    note: '预检失败：未创建 dataRoot、未启动任何子进程、未写任何用例日志。本文件只写入已独立验证安全的 report 目录；report 本身不安全时不会写任何文件。',
  };
  if (!destination) return { written: false, file: null, reason: 'report 未通过独立安全验证，仅输出 stderr' };
  try {
    fs.mkdirSync(destination.declared, { recursive: true });
    fs.writeFileSync(destination.file, JSON.stringify(failure, null, 2), 'utf8');
    return { written: true, file: destination.file, reason: null };
  } catch (error) {
    return { written: false, file: null, reason: `错误报告写入失败：${String(error?.message ?? error)}` };
  }
}

// ── protected roots 快照（B03） ──────────────────────────────────────────────
function snapshotProtected(specs) {
  const roots = [];
  const unreadable = [];
  let filteredRuntimeArtifacts = 0;
  const walk = (rootSpec, dir, base, entries) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ root: rootSpec.label, rootPath: rootSpec.declared, path: toPosix(path.relative(base, dir)) || '.', error: String(error?.message ?? error) });
      return;
    }
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const rel = toPosix(path.relative(base, abs));
      if (rootSpec.live && (LIVE_RUNTIME_FILE.test(item.name) || LIVE_RUNTIME_BASENAMES.has(item.name))) {
        filteredRuntimeArtifacts += 1;
        continue;
      }
      let stat;
      try { stat = fs.lstatSync(abs); } catch (error) {
        unreadable.push({ root: rootSpec.label, rootPath: rootSpec.declared, path: rel, error: String(error?.message ?? error) });
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(abs); } catch { /* ignore */ }
        entries[rel] = { type: 'link', target };
      } else if (stat.isDirectory()) {
        entries[rel] = { type: 'dir' };
        walk(rootSpec, abs, base, entries);
      } else if (stat.isFile()) {
        try {
          const buf = fs.readFileSync(abs);
          entries[rel] = { type: 'file', size: buf.length, sha256: sha256Buffer(buf) };
        } catch (error) {
          unreadable.push({ root: rootSpec.label, rootPath: rootSpec.declared, path: rel, error: String(error?.message ?? error) });
        }
      } else {
        entries[rel] = { type: 'other' };
      }
    }
  };

  for (const spec of specs) {
    const record = { label: spec.label, live: Boolean(spec.live), declared: spec.declared, exists: false, type: null, linkTarget: null, entries: {} };
    try {
      const stat = fs.lstatSync(spec.declared);
      record.exists = true;
      if (stat.isSymbolicLink()) {
        record.type = 'link';
        try { record.linkTarget = fs.readlinkSync(spec.declared); } catch { /* ignore */ }
        let real; try { real = fs.realpathSync(spec.declared); } catch { real = null; }
        if (real) walk(spec, real, real, record.entries);
      } else if (stat.isDirectory()) {
        record.type = 'dir';
        walk(spec, spec.declared, spec.declared, record.entries);
      } else if (stat.isFile()) {
        record.type = 'file';
        try {
          const buf = fs.readFileSync(spec.declared);
          record.entries[''] = { type: 'file', size: buf.length, sha256: sha256Buffer(buf) };
        } catch (error) {
          unreadable.push({ root: spec.label, rootPath: spec.declared, path: '', error: String(error?.message ?? error) });
        }
      } else {
        record.type = 'other';
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        unreadable.push({ root: spec.label, rootPath: spec.declared, path: '', error: String(error?.message ?? error) });
        record.exists = true;
        record.type = 'unreadable';
      }
    }
    roots.push(record);
  }
  return { roots, unreadable, filteredRuntimeArtifacts, takenAt: nowIso() };
}

function diffProtected(before, after) {
  const changes = [];
  const unreadable = [...(before?.unreadable ?? []), ...(after?.unreadable ?? [])];
  const beforeMap = new Map((before?.roots ?? []).map((r) => [r.label, r]));
  for (const afterRoot of after?.roots ?? []) {
    const beforeRoot = beforeMap.get(afterRoot.label);
    if (!beforeRoot) { changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: '', change: 'added' }); continue; }
    if (beforeRoot.exists !== afterRoot.exists) {
      changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: '', change: afterRoot.exists ? 'added' : 'removed', before: beforeRoot.type, after: afterRoot.type });
      continue;
    }
    if (!beforeRoot.exists) continue;
    if (beforeRoot.type !== afterRoot.type) {
      changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: '', change: 'modified', before: beforeRoot.type, after: afterRoot.type });
      continue;
    }
    if (beforeRoot.linkTarget !== afterRoot.linkTarget) {
      changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: '', change: 'modified', before: beforeRoot.linkTarget, after: afterRoot.linkTarget, field: 'linkTarget' });
    }
    const keys = new Set([...Object.keys(beforeRoot.entries ?? {}), ...Object.keys(afterRoot.entries ?? {})]);
    for (const key of keys) {
      const b = beforeRoot.entries?.[key];
      const a = afterRoot.entries?.[key];
      if (!b) changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: key, change: 'added' });
      else if (!a) changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: key, change: 'removed' });
      else if (b.type !== a.type || b.sha256 !== a.sha256 || b.size !== a.size || b.target !== a.target) {
        changes.push({ root: afterRoot.label, rootPath: afterRoot.declared, path: key, change: 'modified', before: b, after: a });
      }
    }
  }
  for (const beforeRoot of before?.roots ?? []) {
    if (!(after?.roots ?? []).some((r) => r.label === beforeRoot.label)) {
      changes.push({ root: beforeRoot.label, rootPath: beforeRoot.declared, path: '', change: 'removed' });
    }
  }
  return { changes, unreadable };
}

function summarizeSnapshot(snapshot) {
  return {
    takenAt: snapshot?.takenAt ?? null,
    filteredRuntimeArtifacts: snapshot?.filteredRuntimeArtifacts ?? 0,
    roots: (snapshot?.roots ?? []).map((r) => ({
      label: r.label, declared: r.declared, exists: r.exists, type: r.type,
      entryCount: Object.keys(r.entries ?? {}).length, linkTarget: r.linkTarget,
    })),
  };
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
function computeCounts(planned) {
  return {
    manifest: planned.length,
    executed: planned.filter((p) => ['passed', 'failed', 'timeout'].includes(p.status)).length,
    passed: planned.filter((p) => p.status === 'passed').length,
    failed: planned.filter((p) => p.status === 'failed').length,
    timeout: planned.filter((p) => p.status === 'timeout').length,
    loadFailure: planned.filter((p) => p.status === 'load-failure').length,
    skipped: planned.filter((p) => p.status === 'skipped').length,
    requiredSkipped: planned.filter((p) => p.status === 'skipped' && p.required).length,
  };
}

function buildReport(ctx) {
  const { args, manifestPath, planned, gates, preflight, policy, policyFiles, violations, snapshotBefore, snapshotAfter, protectedDiff, isolationEnv, startedAt, liveRuntimeExcluded } = ctx;
  const counts = computeCounts(planned);
  const cases = planned.map((p) => ({
    id: p.id, name: p.name, category: p.category ?? null, required: p.required,
    script: p.script, scriptAbs: p.scriptAbs ?? null, args: p.args, cwd: p.cwd,
    sourceSha256: p.sourceSha256 ?? null, log: p.log ?? null,
    status: p.status, exitCode: p.exitCode ?? null, signal: p.signal ?? null,
    timedOut: Boolean(p.timedOut), durationMs: p.durationMs ?? null,
    pid: p.pid ?? null, skipReason: p.skipReason ?? null, error: p.error ?? null,
    writeRoots: p.writeRoots ?? [], allowEndpoints: p.allowEndpoints ?? [],
    expectViolations: Boolean(p.expectViolations), expectViolationsReason: p.expectViolationsReason ?? null,
    violations: (p.violations ?? []).length,
  }));
  return {
    schemaVersion: 2,
    suite: 'personality-tests-baseline',
    runnerVersion: RUNNER_VERSION,
    generatedAt: nowIso(),
    startedAt: startedAt ?? null,
    runner: {
      path: RUNNER_FILE, sha256: sha256File(RUNNER_FILE), version: RUNNER_VERSION,
      node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch,
    },
    manifest: { path: manifestPath, sha256: fs.existsSync(manifestPath) ? sha256File(manifestPath) : null },
    candidateRoot: CANDIDATE_ROOT,
    liveRoot: DEFAULT_LIVE_ROOT,
    invocation: { argv: process.argv.slice(2), cwd: process.cwd() },
    preflight: {
      ok: Boolean(preflight?.ok),
      resolved: {
        dataRoot: preflight?.resolved?.dataRoot ?? null,
        report: preflight?.resolved?.report ?? null,
        policyDir: preflight?.resolved?.policyDir ?? null,
        forbidRoots: preflight?.resolved?.forbidRoots ?? [],
        protectedRoots: (preflight?.resolved?.protectedRoots ?? []).map((p) => ({ label: p.label, declared: p.declared, real: p.real, existed: p.existed, explicit: Boolean(p.explicit) })),
        endpoints: preflight?.resolved?.endpoints ?? [],
      },
      violations: preflight?.violations ?? [],
    },
    isolation: {
      method: 'runner spawn: node --import isolation/preload.mjs <script>；NODE_OPTIONS 让测试再 spawn 的 node 子进程递归注入同一 preload',
      preload: { path: PRELOAD_FILE, sha256: sha256File(PRELOAD_FILE), version: RUNNER_VERSION },
      policy: { file: policy?.file ?? null, sha256: policy?.sha256 ?? null, content: policy?.content ?? null },
      casePolicies: policyFiles,
      violations,
      violationsCount: violations.length,
      expectedViolations: violations.filter((v) => planned.some((p) => p.expectViolations && p.id === v.caseId)),
      unexpectedViolationsCount: violations.filter((v) => !planned.some((p) => p.expectViolations && p.id === v.caseId)).length,
      violationsFile: preflight?.resolved?.violationsFile ?? null,
      selfPortsFile: preflight?.resolved?.selfPortsFile ?? null,
      injectedEnv: {
        A00_ISOLATION_POLICY: '<per-case policy file under dataRoot/policy>',
        A00_DATA_ROOT: preflight?.resolved?.dataRoot?.real ?? null,
        TEMP: isolationEnv?.TEMP ?? null, TMP: isolationEnv?.TMP ?? null,
        NODE_OPTIONS: isolationEnv?.NODE_OPTIONS ?? null,
        A00_TESTS_ISOLATED: '1', QQ_BRIDGE_TEST_LIVE: '0',
      },
      inheritedEnvCount: Object.keys(process.env).length,
      note: '不通过删除环境变量实现隔离；继承的环境值同样受 preload 的写/网络边界约束。',
    },
    protected: {
      roots: (preflight?.resolved?.protectedRoots ?? []).map((p) => ({ label: p.label, declared: p.declared, real: p.real, live: Boolean(p.live), explicit: Boolean(p.explicit) })),
      before: summarizeSnapshot(snapshotBefore),
      after: summarizeSnapshot(snapshotAfter),
      changes: protectedDiff?.changes ?? [],
      unreadable: protectedDiff?.unreadable ?? [],
      excludedLiveRuntime: liveRuntimeExcluded,
      liveRuntimeFilter: { patterns: [String(LIVE_RUNTIME_FILE), ...[...LIVE_RUNTIME_BASENAMES]], filteredCount: (snapshotBefore?.filteredRuntimeArtifacts ?? 0) + (snapshotAfter?.filteredRuntimeArtifacts ?? 0) },
    },
    gates,
    counts,
    sourceHashes: {
      runner: sha256File(RUNNER_FILE),
      preload: sha256File(PRELOAD_FILE),
      pathsLib: sha256File(PATHS_LIB_FILE),
      manifest: fs.existsSync(manifestPath) ? sha256File(manifestPath) : null,
      cases: Object.fromEntries(planned.filter((p) => p.sourceSha256).map((p) => [p.id, p.sourceSha256])),
    },
    cases,
  };
}

function collectViolations(file, planned) {
  const byPid = new Map();
  const all = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { all, byPid }; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      all.push(record);
      const pid = Number(record.pid);
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid).push(record);
    } catch { all.push({ parseError: true, line }); }
  }
  for (const plannedCase of planned) {
    if (plannedCase.pid != null) plannedCase.violations = byPid.get(Number(plannedCase.pid)) ?? [];
  }
  return { all, byPid };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(`参数错误：${error.message}`);
    return 2;
  }
  if (args.help) { printHelp(); return 0; }

  const gates = [];
  const addGate = (id, ok, detail) => gates.push({ id, ok: Boolean(ok), detail });

  // 只读：清单
  const manifestPath = path.resolve(args.manifest ?? DEFAULT_MANIFEST);
  let manifest = null;
  let manifestError = null;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    manifestError = String(error?.message ?? error);
  }
  const allCases = manifestError ? [] : normalizeCases(manifest);

  if (args.list) {
    console.log(`用例清单：${manifestPath}${manifestError ? `（读取失败：${manifestError}）` : ''}`);
    const filtered = args.filter ? allCases.filter((c) => `${c.id} ${c.name} ${c.script}`.includes(args.filter)) : allCases;
    for (const c of filtered) {
      console.log(`${c.skip ? 'SKIP' : 'RUN '}  ${c.id}  required=${c.required}  ${c.script} ${c.args.join(' ')}${c.skip ? `  — ${c.skipReason ?? ''}` : ''}`);
    }
    console.log(`共 ${filtered.length} 项（skip ${filtered.filter((c) => c.skip).length} 项）`);
    return manifestError ? 2 : 0;
  }

  const selectedCases = args.filter
    ? allCases.filter((c) => `${c.id} ${c.name} ${c.script}`.includes(args.filter))
    : allCases;

  addGate('manifest-load', !manifestError, manifestError ? { path: manifestPath, error: manifestError } : { manifest: manifestPath, cases: allCases.length });
  addGate('cases-nonempty', selectedCases.length > 0, { count: selectedCases.length, manifestCases: allCases.length });
  addGate('offline-flag-required', Boolean(args.offline), args.offline ? '--offline' : '本轮不允许非离线运行：必须显式传 --offline');
  addGate('data-root-required', Boolean(args.dataRoot), args.dataRoot ?? '缺少 --data-root');
  addGate('report-dir-required', Boolean(args.report), args.report ?? '缺少 --report');

  // ── 预检（纯读取；失败 => 0 执行 / 不创建 dataRoot） ─────────────────────
  const preflight = computePreflight({ args, manifestPath, cases: allCases, manifestError: manifestError ? manifestError : null });
  addGate('preflight', preflight.ok, {
    violations: preflight.violations,
    manifestLoaded: preflight.manifestLoaded,
    offline: Boolean(args.offline),
    dataRoot: preflight.resolved.dataRoot?.declared ?? null,
    report: preflight.resolved.report?.declared ?? null,
    dataRootReal: preflight.resolved.dataRoot?.real ?? null,
    reportReal: preflight.resolved.report?.real ?? null,
  });
  const forbiddenViolations = preflight.violations.filter((v) => String(v.check).includes('forbidden'));
  const protectedViolations = preflight.violations.filter((v) => String(v.check).includes('protected'));
  addGate('forbidden-path', forbiddenViolations.length === 0, forbiddenViolations);
  addGate('protected-path', protectedViolations.length === 0, protectedViolations);

  if (!preflight.ok) {
    console.error('PRECHECK FAILED：未执行任何用例。');
    for (const violation of preflight.violations) console.error(`  - [${violation.check}] ${violation.reason ?? ''} ${JSON.stringify(violation)}`);
    for (const gate of gates) if (!gate.ok && gate.id !== 'preflight') console.error(`GATE FAIL ${gate.id}: ${JSON.stringify(gate.detail)}`);
    const failure = tryWriteFailureReport({ args, preflight, gates, manifestPath, cases: allCases });
    console.error(failure.written ? `预检失败报告：${failure.file}` : `预检失败报告未写：${failure.reason}`);
    return 2;
  }

  const dataRoot = preflight.resolved.dataRoot;
  const reportDir = preflight.resolved.report;
  const policyDir = preflight.resolved.policyDir;
  const preloadUrl = pathToFileURL(PRELOAD_FILE).href;

  // ── 预检通过后：建立 dataRoot / report / policy ──────────────────────────
  let policyInfo;
  let baseEnv;
  let casePlans = [];
  try {
    for (const dir of [dataRoot.declared, path.join(dataRoot.declared, 'tmp'), path.join(dataRoot.declared, 'memory'),
      path.join(dataRoot.declared, 'home'), path.join(dataRoot.declared, 'policy'), reportDir.declared]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const dataRootRealAfter = fs.realpathSync.native ? fs.realpathSync.native(dataRoot.declared) : fs.realpathSync(dataRoot.declared);
    const reportRealAfter = fs.realpathSync.native ? fs.realpathSync.native(reportDir.declared) : fs.realpathSync(reportDir.declared);
    if (!samePath(dataRootRealAfter, dataRoot.real) || !samePath(reportRealAfter, reportDir.real)) {
      throw new Error(`创建后真实路径与预检不一致：dataRoot ${dataRootRealAfter} vs ${dataRoot.real}；report ${reportRealAfter} vs ${reportDir.real}`);
    }
    const policyDirReal = path.join(dataRoot.real, 'policy');
    const violationsFile = path.join(policyDirReal, 'violations.jsonl');
    const selfPortsFile = path.join(policyDirReal, 'self-ports.jsonl');
    fs.writeFileSync(violationsFile, '', 'utf8');
    fs.writeFileSync(selfPortsFile, '', 'utf8');
    policyInfo = {
      file: path.join(policyDirReal, 'policy.json'),
      sha256: null,
      content: null,
      violationsFile,
      selfPortsFile,
      policyDirReal,
    };

    baseEnv = { ...process.env };
    delete baseEnv.QQ_DRY_RUN;
    const nodeOptions = [process.env.NODE_OPTIONS, `--import "${preloadUrl}"`].filter(Boolean).join(' ');
    const isolationEnv = {
      A00_DATA_ROOT: dataRoot.real,
      A00_TESTS_ISOLATED: '1',
      TEMP: path.join(dataRoot.real, 'tmp'),
      TMP: path.join(dataRoot.real, 'tmp'),
      TMPDIR: path.join(dataRoot.real, 'tmp'),
      MEMORY_MCP_ROOT: path.join(dataRoot.real, 'memory'),
      MEMORY_SCOPE_SECRET_FILE: path.join(dataRoot.real, 'memory', 'scope.key'),
      QQ_BRIDGE_TEST_LIVE: '0',
      NODE_OPTIONS: nodeOptions,
    };
    if (process.env.A00_ISOLATION_DEBUG === '1') isolationEnv.A00_ISOLATION_DEBUG = '1';

    // 规划用例 + 写每用例策略
    let index = 0;
    const policyFiles = [];
    for (const c of selectedCases) {
      const plan = {
        id: c.id, name: c.name, category: c.category, required: c.required, skip: c.skip,
        skipReason: c.skipReason, script: c.script, args: c.args, requiredWriteRoots: c.writeRoots,
        timeoutMs: c.timeoutMs ?? Number(manifest?.defaultTimeoutMs ?? 120000),
        allowEndpoints: c.allowEndpoints,
        expectViolations: c.expectViolations === true,
        expectViolationsReason: typeof c.expectViolationsReason === 'string' ? c.expectViolationsReason : null,
      };
      plan.scriptAbs = path.resolve(CANDIDATE_ROOT, c.script);
      plan.cwd = path.resolve(CANDIDATE_ROOT, c.cwd ?? '.');
      if (c.skip) plan.status = 'skipped';
      else if (!fs.existsSync(plan.scriptAbs)) {
        plan.status = 'load-failure';
        plan.error = `脚本不存在：${plan.scriptAbs}`;
      }
      casePlans.push(plan);
      if (plan.status) continue;
      index += 1;
      const caseWriteRoots = [];
      for (const raw of c.writeRoots) {
        const dir = path.resolve(dataRoot.real, raw);
        fs.mkdirSync(dir, { recursive: true });
        caseWriteRoots.push(dir);
      }
      const endpoints = [...preflight.resolved.endpoints, ...(c.allowEndpoints ? c.allowEndpoints.map((text) => parseEndpoint(text)).filter(Boolean) : [])];
      const policyContent = {
        schemaVersion: 1,
        version: RUNNER_VERSION,
        generatedAt: nowIso(),
        runnerPid: process.pid,
        runnerFile: RUNNER_FILE,
        runnerSha256: sha256File(RUNNER_FILE),
        preloadFile: PRELOAD_FILE,
        preloadSha256: sha256File(PRELOAD_FILE),
        caseId: c.id,
        dataRoot: dataRoot.real,
        reportDir: reportDir.real,
        writeRoots: [...new Set([dataRoot.real, reportDir.real, path.join(dataRoot.real, 'tmp'),
          path.join(dataRoot.real, 'memory'), path.join(dataRoot.real, 'home'), ...caseWriteRoots])],
        denyWritePaths: [policyDirReal, violationsFile, selfPortsFile, policyInfo.file],
        protectedRoots: preflight.resolved.protectedRoots.map((p) => p.real).filter(Boolean),
        allowEndpoints: endpoints,
        loopbackSelfPorts: true,
        violationsFile,
        selfPortsFile,
      };
      const policyPath = path.join(policyDirReal, `case-${String(index).padStart(3, '0')}-${c.id}.json`);
      fs.writeFileSync(policyPath, JSON.stringify(policyContent, null, 2), 'utf8');
      policyFiles.push({ caseId: c.id, file: policyPath, sha256: sha256File(policyPath) });
      plan.policyFile = policyPath;
      plan.writeRoots = caseWriteRoots;
      plan.allowEndpoints = c.allowEndpoints ?? [];
    }
    // dataRoot 根策略（证据用；子进程实际使用 per-case 策略）
    const basePolicyContent = {
      schemaVersion: 1, version: RUNNER_VERSION, generatedAt: nowIso(), runnerPid: process.pid,
      dataRoot: dataRoot.real, reportDir: reportDir.real,
      writeRoots: [dataRoot.real, reportDir.real, path.join(dataRoot.real, 'tmp')],
      denyWritePaths: [policyDirReal, violationsFile, selfPortsFile, policyInfo.file],
      protectedRoots: preflight.resolved.protectedRoots.map((p) => p.real).filter(Boolean),
      allowEndpoints: preflight.resolved.endpoints,
      violationsFile, selfPortsFile,
    };
    fs.writeFileSync(policyInfo.file, JSON.stringify(basePolicyContent, null, 2), 'utf8');
    policyInfo.sha256 = sha256File(policyInfo.file);
    policyInfo.content = basePolicyContent;
    policyInfo.casePolicies = policyFiles;
    baseEnv.__A00_ISOLATION_ENV = isolationEnv;
  } catch (error) {
    console.error(`初始化隔离环境失败：${String(error?.message ?? error)}`);
    try {
      fs.mkdirSync(reportDir.declared, { recursive: true });
      fs.writeFileSync(path.join(reportDir.declared, 'preflight-failure.json'), JSON.stringify({
        schemaVersion: 2, phase: 'init', error: String(error?.message ?? error), gates, executed: 0,
      }, null, 2), 'utf8');
    } catch { /* ignore */ }
    return 2;
  }

  const isolationEnv = baseEnv.__A00_ISOLATION_ENV;
  delete baseEnv.__A00_ISOLATION_ENV;
  const childBaseEnv = { ...baseEnv, ...isolationEnv };

  // 线上运行时目录单列（不纳入门禁）
  const liveRuntimeExcluded = [];
  for (const rel of LIVE_RUNTIME_EXCLUDED) {
    const full = path.join(DEFAULT_LIVE_ROOT, rel);
    if (fs.existsSync(full)) {
      liveRuntimeExcluded.push({ path: full, reason: '线上常驻进程持续写入，按 Lead 要求排除在 B03 失败门禁外' });
    }
  }

  // ── B03 before 快照 ──────────────────────────────────────────────────────
  const protectedSpecs = preflight.resolved.protectedRoots;
  const snapshotBefore = snapshotProtected(protectedSpecs);
  const startedAt = nowIso();

  // ── 执行（B02 注入） ─────────────────────────────────────────────────────
  const planned = [];
  if (snapshotBefore.unreadable.length > 0) {
    console.error(`PROTECTED UNREADABLE（before）：${JSON.stringify(snapshotBefore.unreadable)}`);
    for (const plan of casePlans) {
      planned.push({
        id: plan.id, name: plan.name, category: plan.category, required: plan.required,
        script: plan.script, args: plan.args, cwd: plan.cwd, status: 'not-run',
        exitCode: null, skipReason: null, error: 'protected roots 在运行前不可读，拒绝执行',
        writeRoots: plan.writeRoots ?? [], allowEndpoints: plan.allowEndpoints ?? [],
      });
    }
  } else {
    for (const plan of casePlans) {
      const plannedCase = {
        id: plan.id, name: plan.name, category: plan.category, required: plan.required,
        script: plan.script, args: plan.args, cwd: plan.cwd, timeoutMs: plan.timeoutMs,
        writeRoots: plan.writeRoots ?? [], allowEndpoints: plan.allowEndpoints ?? [],
        expectViolations: Boolean(plan.expectViolations), expectViolationsReason: plan.expectViolationsReason ?? null,
      };
      if (plan.status === 'skipped') {
        plannedCase.status = 'skipped';
        plannedCase.skipReason = plan.skipReason ?? '(清单标记 skip，未写理由)';
        plannedCase.exitCode = null;
        planned.push(plannedCase);
        console.log(`SKIP ${plan.id} — ${plannedCase.skipReason}`);
        continue;
      }
      if (plan.status === 'load-failure') {
        plannedCase.status = 'load-failure';
        plannedCase.error = plan.error;
        plannedCase.exitCode = null;
        planned.push(plannedCase);
        console.error(`LOAD-FAIL ${plan.id}：${plan.error}`);
        continue;
      }
      plannedCase.scriptAbs = plan.scriptAbs;
      plannedCase.sourceSha256 = sha256File(plan.scriptAbs);
      const logFile = path.join(reportDir.declared, `${plan.id}.log`);
      plannedCase.log = logFile;
      plannedCase.policyFile = plan.policyFile;
      const childEnv = { ...childBaseEnv, A00_ISOLATION_POLICY: plan.policyFile };

      const startedCase = nowIso();
      const t0 = Date.now();
      let child;
      try {
        child = spawn(process.execPath, ['--import', preloadUrl, plan.scriptAbs, ...plan.args], {
          cwd: plan.cwd,
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        plannedCase.status = 'failed';
        plannedCase.spawnError = String(error?.message ?? error);
        plannedCase.exitCode = null;
        planned.push(plannedCase);
        continue;
      }
      plannedCase.pid = child.pid ?? null;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, plan.timeoutMs);
      const exitInfo = await new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }));
        child.on('error', (error) => resolve({ code: null, signal: null, error: String(error?.message ?? error) }));
      });
      clearTimeout(timer);
      plannedCase.durationMs = Date.now() - t0;
      plannedCase.startedAt = startedCase;
      plannedCase.finishedAt = nowIso();
      plannedCase.exitCode = exitInfo.code;
      plannedCase.signal = exitInfo.signal ?? null;
      plannedCase.timedOut = timedOut;
      if (exitInfo.error) plannedCase.spawnError = exitInfo.error;

      const header = [
        `# case: ${plan.id}`, `# name: ${plan.name}`, `# script: ${plan.scriptAbs}`, `# args: ${JSON.stringify(plan.args)}`,
        `# cwd: ${plan.cwd}`, `# started: ${startedCase}`, `# finished: ${plannedCase.finishedAt}`,
        `# timeoutMs: ${plan.timeoutMs}`, `# timedOut: ${timedOut}`, `# exitCode: ${exitInfo.code}`,
        `# isolation: node --import isolation/preload.mjs；policy=${plan.policyFile}；TEMP=${isolationEnv.TEMP}`,
        '', '=== STDOUT ===', stdout, '=== STDERR ===', stderr,
      ].join('\n');
      try { fs.writeFileSync(logFile, header, 'utf8'); } catch (error) {
        plannedCase.logWriteError = String(error?.message ?? error);
      }

      if (timedOut) plannedCase.status = 'timeout';
      else if (exitInfo.code === 0) plannedCase.status = 'passed';
      else plannedCase.status = 'failed';
      planned.push(plannedCase);
      console.log(`${plannedCase.status.toUpperCase()} ${plan.id} (exit=${exitInfo.code}, ${plannedCase.durationMs}ms)${plannedCase.status === 'passed' ? '' : ` — 见 ${path.basename(logFile)}`}`);
    }
  }

  // ── B03 after 快照 + violations ─────────────────────────────────────────
  const snapshotAfter = snapshotProtected(protectedSpecs);
  const protectedDiff = diffProtected(snapshotBefore, snapshotAfter);
  const violationInfo = collectViolations(policyInfo.violationsFile, planned);

  // ── 门禁 ─────────────────────────────────────────────────────────────────
  const loadFailures = planned.filter((p) => p.status === 'load-failure');
  const failed = planned.filter((p) => ['failed', 'timeout', 'load-failure'].includes(p.status));
  const skipped = planned.filter((p) => p.status === 'skipped');
  const requiredSkipped = skipped.filter((p) => p.required);
  addGate('case-load', loadFailures.length === 0, loadFailures.map((p) => ({ id: p.id, error: p.error })));
  addGate('subprocess-nonzero', failed.length === 0, failed.map((p) => ({ id: p.id, status: p.status, exitCode: p.exitCode, timedOut: p.timedOut })));
  addGate('required-skipped', requiredSkipped.length === 0, requiredSkipped.map((p) => ({ id: p.id, reason: p.skipReason })));
  // no-violations：manifest 显式声明 expectViolations 的自检用例（如 selftest-isolation）
  // 允许自己产生 N 条违规用于证明“拦截确实发生”，但必须真的产生；其余任何违规照样失败。
  // 归属用 runner 写入策略的 caseId（跨孙进程也有效），不信任被测代码。
  const expectedCaseIds = new Set(planned.filter((p) => p.expectViolations).map((p) => p.id));
  const expectedViolations = violationInfo.all.filter((v) => v.caseId && expectedCaseIds.has(v.caseId));
  const unexpectedViolations = violationInfo.all.filter((v) => !(v.caseId && expectedCaseIds.has(v.caseId)));
  const expectedWithoutViolations = planned
    .filter((p) => p.expectViolations && p.status === 'passed')
    .map((p) => p.id)
    .filter((id) => !expectedViolations.some((v) => v.caseId === id));
  addGate('no-violations', unexpectedViolations.length === 0 && expectedWithoutViolations.length === 0, {
    count: violationInfo.all.length,
    unexpectedCount: unexpectedViolations.length,
    expectedCount: expectedViolations.length,
    expectedCaseIds: [...expectedCaseIds],
    expectedWithoutViolations,
    violations: unexpectedViolations.slice(0, 200),
    expectedViolations: expectedViolations.slice(0, 200),
    violationsFile: policyInfo.violationsFile,
    note: 'expectViolations 只能来自受信 manifest，不允许子进程自行声明；自检用例必须真实产生违规（否则 expectedWithoutViolations 失败）。',
  });
  addGate('protected-unchanged', protectedDiff.changes.length === 0 && protectedDiff.unreadable.length === 0, {
    changes: protectedDiff.changes.slice(0, 500),
    changeCount: protectedDiff.changes.length,
    unreadable: protectedDiff.unreadable,
    before: summarizeSnapshot(snapshotBefore),
    after: summarizeSnapshot(snapshotAfter),
    excludedLiveRuntime: liveRuntimeExcluded,
  });

  const report = buildReport({
    args, manifestPath, planned,
    gates, preflight, policy: policyInfo,
    policyFiles: policyInfo.casePolicies ?? [],
    violations: violationInfo.all,
    snapshotBefore, snapshotAfter, protectedDiff,
    isolationEnv, startedAt, liveRuntimeExcluded,
  });
  report.sourceHashes.cases = Object.fromEntries(planned.filter((p) => p.sourceSha256).map((p) => [p.id, p.sourceSha256]));

  const reportFile = path.join(reportDir.declared, 'run-report.json');
  let reportWritten = false;
  let reportVerifyError = null;
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    const parsed = readJson(reportFile);
    const counts = computeCounts(planned);
    reportWritten = Array.isArray(parsed.cases) && parsed.cases.length === planned.length && parsed.counts.executed === counts.executed;
    if (!reportWritten) reportVerifyError = '报告内容与内存状态不一致';
  } catch (error) {
    reportVerifyError = String(error?.message ?? error);
  }
  addGate('report-written', reportWritten, reportWritten ? { report: reportFile } : (reportVerifyError ?? '报告缺失或不可解析'));
  addGate('report-safe', reportWritten, {
    report: reportFile,
    reportReal: reportDir.real,
    inForbidden: preflight.resolved.forbidRoots.some((f) => f.real && isInside(f.real, reportDir.real)),
    inProtected: preflight.resolved.protectedRoots.some((p) => p.real && isInside(p.real, reportDir.real)),
    note: 'report 位置在预检已独立验证；运行时再次校验写入成功。',
  });
  report.gates = gates;
  try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8'); } catch { /* report-written 已记录 */ }

  // ── 汇总输出 ─────────────────────────────────────────────────────────────
  const counts = computeCounts(planned);
  const ok = gates.every((g) => g.ok);
  console.log('\n──── 汇总 ────');
  console.log(`用例清单：${manifestPath}`);
  console.log(`清单 ${casePlans.length} 项；执行 ${counts.executed} 项；通过 ${counts.passed}；失败/超时/加载失败 ${failed.length}；跳过 ${counts.skipped}（其中必测跳过 ${counts.requiredSkipped}）`);
  console.log(`隔离违规 ${violationInfo.all.length} 条；protected 变化 ${protectedDiff.changes.length} 条；protected 不可读 ${protectedDiff.unreadable.length} 条`);
  console.log(`node ${process.version}；runner ${RUNNER_VERSION} sha256=${sha256File(RUNNER_FILE).slice(0, 16)}；dataRoot=${dataRoot.real}`);
  for (const gate of gates) console.log(`GATE ${gate.ok ? 'PASS' : 'FAIL'} ${gate.id}`);
  console.log(`退出码：${ok ? 0 : 1}`);
  return ok ? 0 : 1;
}

process.exitCode = await main();
