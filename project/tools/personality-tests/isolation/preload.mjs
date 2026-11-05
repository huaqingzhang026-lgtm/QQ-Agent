// A00-rework2 子进程 I/O 隔离 preload（B02 + C01/C02/C03）。
//
// 由 runner 以 `node --import <fileURL> <script>` 注入。
// 策略来自 runner 写入 dataRoot/policy/ 的 JSON 文件（环境变量 A00_ISOLATION_POLICY 指定；
// 缺失即 fail-closed，不依赖用户环境变量的“内容”做判断）。
//
// 拦截面：
//   - node:fs / node:fs/promises 的写/建/改/删类 API（sync + callback + promise + stream + fd）
//   - C01 硬链接：禁止从允许写根外/受禁 inode 建可写硬链接；写前检查目标 nlink>1（预置别名），
//     仅放行本进程经受控 link API 在允许根内创建的多链接 inode
//   - C02 每次写操作按当前 realpath 重新判定（无永久 allowed 缓存）
//   - C03 受控子进程：Node 后代强制可信 execPath + --import preload + 强制策略 env；
//     非 Node / shell:true / 字符串 shell 命令在副作用前拒绝；worker_threads 注入 execArgv
//   - 网络：globalThis.fetch / WebSocket、node:http(s).request/get、node:net.connect、
//     node:tls.connect。默认拒绝；只允许 --allow-endpoint 与自监听 loopback 端口。
//
// 违规在副作用发生前抛错（sync）或返回 rejected promise（async），并追加 violations.jsonl。
// 残余限制见 A00-rework2 evidence/isolation/design.md。
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  resolveRealTarget, isInside, samePath, toPosix, isLoopbackHost, parseEndpoint,
} from '../lib/paths.mjs';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const childProcess = require('node:child_process');
const workerThreads = require('node:worker_threads');

// ── 先抓原始实现，后续所有内部使用都走这里，避免被自己的 patch 递归 ──────────────
const O = {
  readFileSync: fs.readFileSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  realpathSync: fs.realpathSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
};

// 内部追加写：必须走已捕获的底层 fd API。
// 不能用 fs.appendFileSync —— Node 的 appendFileSync 内部会调用被我们 patch 的 writeFileSync，
// 导致违规记录本身再次触发守卫（递归）。
function rawAppend(file, text) {
  const fd = O.openSync(file, 'a');
  try { O.writeSync(fd, text); } finally { O.closeSync(fd); }
}
const realpathNative = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native.bind(fs.realpathSync) : null;
const fsImpl = {
  statSync: O.statSync,
  realpathSync: realpathNative
    ? Object.assign((p) => realpathNative(p), { native: realpathNative })
    : O.realpathSync,
  lstatSync: fs.lstatSync.bind(fs),
};

function fatal(message) {
  try { process.stderr.write(`[a00-isolation] FATAL: ${message}\n`); } catch { /* ignore */ }
  throw new Error(`[a00-isolation] FATAL: ${message}`);
}

// ── 载入并校验策略 ────────────────────────────────────────────────────────────
const policyPathRaw = process.env.A00_ISOLATION_POLICY;
if (!policyPathRaw) fatal('A00_ISOLATION_POLICY 未设置：拒绝在无隔离策略下运行子进程');
const policyPath = path.resolve(policyPathRaw);
let policy;
try { policy = JSON.parse(O.readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, '')); } catch (error) {
  fatal(`策略文件不可读/不可解析：${policyPath}（${String(error?.message ?? error)}）`);
}
if (!policy || typeof policy !== 'object') fatal('策略文件不是对象');
if (policy.schemaVersion !== 1) fatal(`不支持的策略 schemaVersion：${policy.schemaVersion}`);
if (typeof policy.dataRoot !== 'string') fatal('策略缺少 dataRoot');
if (!Array.isArray(policy.writeRoots) || policy.writeRoots.length === 0) fatal('策略缺少 writeRoots');
if (typeof policy.violationsFile !== 'string') fatal('策略缺少 violationsFile');
if (typeof policy.selfPortsFile !== 'string') fatal('策略缺少 selfPortsFile');

const dataRootReal = resolveRealTarget(fsImpl, policy.dataRoot).real;
if (!dataRootReal) fatal(`策略 dataRoot 无法解析：${policy.dataRoot}`);
const policyReal = resolveRealTarget(fsImpl, policyPath).real;
if (!policyReal || !isInside(dataRootReal, policyReal)) fatal('策略文件不在策略 dataRoot 内：拒绝加载被外置/替换的策略');

// 允许写根完全由 runner 下发的策略决定（runner 会显式包含 dataRoot/report/TEMP/writeRoots；
// 自检可用更窄的策略证明边界）。不在此隐式扩大 dataRoot。
const writeRoots = [...new Set(
  policy.writeRoots.map((p) => resolveRealTarget(fsImpl, p).real).filter(Boolean),
)];
if (writeRoots.length === 0) fatal('策略 writeRoots 为空：拒绝在无允许写根下运行');
const denyWritePaths = [...new Set(
  [policyReal, policy.violationsFile, policy.selfPortsFile, ...(Array.isArray(policy.denyWritePaths) ? policy.denyWritePaths : [])]
    .map((p) => resolveRealTarget(fsImpl, p).real)
    .filter(Boolean),
)];
const violationsFile = resolveRealTarget(fsImpl, policy.violationsFile).real;
const selfPortsFile = resolveRealTarget(fsImpl, policy.selfPortsFile).real;
if (!violationsFile || !isInside(dataRootReal, violationsFile)) fatal('violationsFile 不在 dataRoot 内');
if (!selfPortsFile || !isInside(dataRootReal, selfPortsFile)) fatal('selfPortsFile 不在 dataRoot 内');
const allowEndpoints = (Array.isArray(policy.allowEndpoints) ? policy.allowEndpoints : [])
  .map((e) => (typeof e === 'string' ? parseEndpoint(e) : (e && Number.isInteger(e.port) ? { host: String(e.host ?? '').toLowerCase(), port: e.port } : null)))
  .filter(Boolean);
const protectedRoots = (Array.isArray(policy.protectedRoots) ? policy.protectedRoots : [])
  .map((p) => resolveRealTarget(fsImpl, p).real).filter(Boolean);

// ── C03 受控子进程/worker 需要的强制值（不信任用例传入的 env） ────────────────
const PRELOAD_FILE_PATH = fileURLToPath(import.meta.url);
const PRELOAD_URL = pathToFileURL(PRELOAD_FILE_PATH).href;
const FORCED_CHILD_ENV = {
  A00_ISOLATION_POLICY: policyPath,
  A00_DATA_ROOT: dataRootReal,
  A00_TESTS_ISOLATED: '1',
  QQ_BRIDGE_TEST_LIVE: '0',
  TEMP: path.join(dataRootReal, 'tmp'),
  TMP: path.join(dataRootReal, 'tmp'),
  TMPDIR: path.join(dataRootReal, 'tmp'),
};
const NODE_OPTIONS_INJECT = `--import "${PRELOAD_URL}"`;

// C01：本进程经受控 link API 在允许写根内创建的多链接 inode（dev:ino）。
// 只有这类 inode 允许在 nlink>1 时继续写；预先存在的外部硬链接别名一律拒绝。
const ownedMultiLinkInodes = new Set();

function inodeKeyOf(stat) {
  try { return `${String(stat.dev)}:${String(stat.ino)}`; } catch { return null; }
}

// ── 违规记录 ─────────────────────────────────────────────────────────────────
function violation(kind, api, detail) {
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    caseId: policy.caseId ?? null,
    caseVersion: policy.version ?? null,
    kind,
    api,
    ...detail,
  };
  try { rawAppend(violationsFile, `${JSON.stringify(record)}\n`); } catch { /* 二次失败也不能放行 */ }
  const where = detail?.target ?? detail?.url ?? detail?.fd ?? '?';
  const error = new Error(`[a00-isolation] ${kind} blocked by ${api}: ${where}`);
  error.code = 'A00_ISOLATION_VIOLATION';
  error.a00Violation = record;
  return error;
}

// ── 写路径判定（C02：无永久缓存，每次按当前 realpath 重算） ─────────────────
function normalizePathArg(raw) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof NodeURL) { try { return fileURLToPath(raw); } catch { return null; } }
  if (Buffer.isBuffer(raw)) return raw.toString();
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString();
  return null;
}

function decidePath(rawPath) {
  const declared = path.resolve(rawPath);
  const resolved = resolveRealTarget(fsImpl, declared);
  let decision;
  if (!resolved.real) {
    // 词法路径落在允许写根内、但 realpath 失败仅因“某个祖先不是目录”：
    // 交给 OS 自然失败（OS 不会写到根外），例如测试故意把 nope-<pid> 建成文件再写其子路径。
    // 词法路径越界（或祖先 realpath 失败可能掩盖别名）时仍拒绝。
    const lexicalAllowed = resolved.invalid === 'existing-ancestor-not-a-directory'
      && writeRoots.some((w) => isInside(w, declared))
      && !denyWritePaths.some((d) => isInside(d, declared))
      && !protectedRoots.some((p) => isInside(p, declared));
    decision = lexicalAllowed
      ? { allowed: true, real: declared, reason: 'lexical-inside-write-root-ancestor-not-dir' }
      : { allowed: false, real: null, reason: resolved.invalid ?? 'unresolvable-target' };
  } else if (denyWritePaths.some((d) => isInside(d, resolved.real))) {
    decision = { allowed: false, real: resolved.real, reason: 'deny-write-path' };
  } else if (protectedRoots.some((p) => isInside(p, resolved.real))) {
    decision = { allowed: false, real: resolved.real, reason: 'protected-root' };
  } else if (writeRoots.some((w) => isInside(w, resolved.real))) {
    decision = { allowed: true, real: resolved.real, reason: 'write-root' };
  } else {
    decision = { allowed: false, real: resolved.real, reason: 'outside-write-roots' };
  }
  return decision;
}

// 删除/移动“目录项”时不能把 final symlink/junction 解析到目标：unlink/rm/rename 只改动
// 允许根内的链接项本身，不会写目标。用父目录 realpath + basename 校验。
function decideLinkEntryPath(rawPath) {
  const declared = path.resolve(rawPath);
  const parentResolved = resolveRealTarget(fsImpl, path.dirname(declared));
  const real = parentResolved.real ? path.join(parentResolved.real, path.basename(declared)) : declared;
  let decision;
  if (denyWritePaths.some((d) => isInside(d, real))) {
    decision = { allowed: false, real, reason: 'deny-write-path' };
  } else if (protectedRoots.some((p) => isInside(p, real))) {
    decision = { allowed: false, real, reason: 'protected-root' };
  } else if (writeRoots.some((w) => isInside(w, real))) {
    decision = { allowed: true, real, reason: 'write-root-link-entry' };
  } else {
    decision = { allowed: false, real, reason: 'outside-write-roots' };
  }
  return decision;
}

// C01：已存在目标若是多链接硬链接别名（且非本进程受控 link 创建），写前拒绝。
function guardExistingHardlinkAlias(rawTarget, api) {
  const p = normalizePathArg(rawTarget);
  if (p == null) return;
  const declared = path.resolve(p);
  const resolved = resolveRealTarget(fsImpl, declared);
  if (!resolved.real) return;
  let stat;
  try { stat = O.statSync(resolved.real); } catch { return; }
  if (!stat.isFile()) return;
  const nlink = Number(stat.nlink);
  if (!(nlink > 1)) return;
  const key = inodeKeyOf(stat);
  if (key && ownedMultiLinkInodes.has(key)) return;
  throw violation('write', api, {
    target: declared,
    real: resolved.real,
    nlink,
    reason: 'existing-target-has-multiple-hardlinks',
  });
}

// 公共写判定入口：path 或 fd。options.checkLinks=true 表示内容/元数据修改，写前查硬链接别名。
function guardWrite(rawTarget, api, options = {}) {
  if (typeof rawTarget === 'number') {
    guardFd(rawTarget, api, options);
    return;
  }
  const p = normalizePathArg(rawTarget);
  if (p == null) return;
  const decision = options.linkEntry ? decideLinkEntryPath(p) : decidePath(p);
  if (!decision.allowed) {
    throw violation('write', api, {
      target: path.resolve(p),
      real: decision.real,
      reason: decision.reason,
    });
  }
  if (options.checkLinks) guardExistingHardlinkAlias(p, api);
}

const fdMap = new Map();

function guardFd(fd, api, options = {}) {
  const n = Number(fd);
  if (n === 0 || n === 1 || n === 2) return; // stdin/stdout/stderr：pipe 写不算文件写
  const known = fdMap.get(n);
  if (known == null) throw violation('write', api, { fd: n, reason: 'unknown-fd' });
  guardWrite(known, api, options);
}

// C01：link 源校验 + 成功后的受控 inode 登记。
function guardHardLinkSource(rawSource, api) {
  const p = normalizePathArg(rawSource);
  if (p == null) return;
  const declared = path.resolve(p);
  const resolved = resolveRealTarget(fsImpl, declared);
  if (!resolved.real) return; // 不存在/祖先非目录：交给 OS 失败
  let stat;
  try { stat = O.statSync(resolved.real); } catch { return; }
  if (!stat.isFile()) return; // 目录等交给 OS
  const real = resolved.real;
  if (denyWritePaths.some((d) => isInside(d, real)) || protectedRoots.some((pr) => isInside(pr, real))) {
    throw violation('write', api, { target: declared, real, reason: 'hardlink-source-forbidden' });
  }
  if (!writeRoots.some((w) => isInside(w, real))) {
    throw violation('write', api, { target: declared, real, reason: 'hardlink-source-outside-write-roots' });
  }
  const nlink = Number(stat.nlink);
  if (nlink > 1) {
    const key = inodeKeyOf(stat);
    if (!key || !ownedMultiLinkInodes.has(key)) {
      throw violation('write', api, { target: declared, real, nlink, reason: 'hardlink-source-has-multiple-hardlinks' });
    }
  }
}

function trackCreatedHardlink(rawDest) {
  const p = normalizePathArg(rawDest);
  if (p == null) return;
  try {
    const resolved = resolveRealTarget(fsImpl, path.resolve(p));
    if (!resolved.real) return;
    const stat = O.statSync(resolved.real);
    if (stat.isFile() && Number(stat.nlink) > 1) {
      const key = inodeKeyOf(stat);
      if (key) ownedMultiLinkInodes.add(key);
    }
  } catch { /* ignore */ }
}

function guardHardLink(source, dest, api) {
  guardWrite(dest, api);            // 目标必须在允许写根内
  guardHardLinkSource(source, api); // 来源必须在允许写根内且非外部多链接
}

function flagsWritable(flags, constants = fs.constants) {
  if (typeof flags === 'number') {
    return Boolean(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND));
  }
  if (flags == null) return false;
  const text = String(flags);
  return /[wa+]/i.test(text);
}

// ── fs 拦截（sync / callback / promises / stream / fd） ──────────────────────
// C01：内容/元数据修改类调用带 checkLinks=true；创建/删除/目录移动类不带。
// link/linkSync/link(promise) 单独实现：校验来源、登记受控多链接 inode。
function installFsGuards() {
  const syncContent = ['writeFileSync', 'appendFileSync', 'truncateSync', 'chmodSync', 'lchmodSync',
    'chownSync', 'lchownSync', 'utimesSync', 'lutimesSync'];
  for (const name of syncContent) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[0], `fs.${name}`, { checkLinks: true });
      return original.apply(fs, args);
    };
  }
  const syncCreate = ['mkdirSync', 'mkdtempSync'];
  for (const name of syncCreate) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[0], `fs.${name}`);
      return original.apply(fs, args);
    };
  }
  const syncRemove = ['rmSync', 'rmdirSync', 'unlinkSync'];
  for (const name of syncRemove) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[0], `fs.${name}`, { linkEntry: true });
      return original.apply(fs, args);
    };
  }
  const origRenameSync = fs.renameSync;
  if (typeof origRenameSync === 'function') {
    fs.renameSync = function patched(...args) {
      guardWrite(args[0], 'fs.renameSync', { linkEntry: true });
      guardWrite(args[1], 'fs.renameSync', { linkEntry: true });
      return origRenameSync.apply(fs, args);
    };
  }
  for (const name of ['copyFileSync', 'cpSync']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[1], `fs.${name}`, { checkLinks: true });
      return original.apply(fs, args);
    };
  }
  if (typeof fs.symlinkSync === 'function') {
    const original = fs.symlinkSync;
    fs.symlinkSync = function patched(...args) {
      guardWrite(args[1], 'fs.symlinkSync');
      return original.apply(fs, args);
    };
  }
  if (typeof fs.linkSync === 'function') {
    const original = fs.linkSync;
    fs.linkSync = function patched(source, dest) {
      guardHardLink(source, dest, 'fs.linkSync');
      const result = original.call(fs, source, dest);
      trackCreatedHardlink(dest);
      return result;
    };
  }
  const syncFd = ['ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync', 'writeSync', 'writevSync'];
  for (const name of syncFd) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardFd(args[0], `fs.${name}`, { checkLinks: true });
      return original.apply(fs, args);
    };
  }

  const cbContent = ['writeFile', 'appendFile', 'truncate', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes'];
  for (const name of cbContent) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[0], `fs.${name}`, { checkLinks: true });
      return original.apply(fs, args);
    };
  }
  const cbCreate = ['mkdir', 'mkdtemp'];
  for (const name of cbCreate) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[0], `fs.${name}`);
      return original.apply(fs, args);
    };
  }
  const cbRemove = ['rm', 'rmdir', 'unlink'];
  for (const name of cbRemove) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[0], `fs.${name}`, { linkEntry: true });
      return original.apply(fs, args);
    };
  }
  if (typeof fs.rename === 'function') {
    const original = fs.rename;
    fs.rename = function patched(...args) {
      guardWrite(args[0], 'fs.rename', { linkEntry: true });
      guardWrite(args[1], 'fs.rename', { linkEntry: true });
      return original.apply(fs, args);
    };
  }
  for (const name of ['copyFile', 'cp']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardWrite(args[1], `fs.${name}`, { checkLinks: true });
      return original.apply(fs, args);
    };
  }
  if (typeof fs.symlink === 'function') {
    const original = fs.symlink;
    fs.symlink = function patched(...args) {
      guardWrite(args[1], 'fs.symlink');
      return original.apply(fs, args);
    };
  }
  if (typeof fs.link === 'function') {
    const original = fs.link;
    fs.link = function patched(source, dest, callback) {
      guardHardLink(source, dest, 'fs.link');
      const cb = typeof callback === 'function' ? callback : null;
      const wrapped = function onLink(...cbArgs) {
        if (!cbArgs[0]) trackCreatedHardlink(dest);
        if (cb) return cb.apply(this, cbArgs);
        return undefined;
      };
      return original.call(fs, source, dest, wrapped);
    };
  }
  const cbFd = ['ftruncate', 'fchmod', 'fchown', 'futimes', 'write', 'writev'];
  for (const name of cbFd) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      guardFd(args[0], `fs.${name}`, { checkLinks: true });
      return original.apply(fs, args);
    };
  }

  // open / close：记录 fd -> path，写标志先判定；写打开对多链接别名做写前拒绝。
  const origOpenSync = fs.openSync;
  fs.openSync = function patched(target, flags, mode) {
    const writable = flagsWritable(flags);
    if (writable) guardWrite(target, 'fs.openSync', { checkLinks: true });
    const fd = origOpenSync.call(fs, target, flags, mode);
    const p = normalizePathArg(target);
    if (p != null) fdMap.set(Number(fd), path.resolve(p));
    return fd;
  };
  const origOpen = fs.open;
  fs.open = function patched(target, flags, mode, callback) {
    let cb = callback;
    let modeArg = mode;
    if (typeof mode === 'function') { cb = mode; modeArg = undefined; }
    if (flagsWritable(flags)) guardWrite(target, 'fs.open', { checkLinks: true });
    const p = normalizePathArg(target);
    const wrapped = function onOpen(error, fd) {
      if (!error && p != null) fdMap.set(Number(fd), path.resolve(p));
      if (typeof cb === 'function') return cb.call(this, error, fd);
      return undefined;
    };
    return origOpen.call(fs, target, flags, modeArg, wrapped);
  };
  for (const name of ['closeSync', 'close']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      const fd = Number(args[0]);
      if (name === 'closeSync') fdMap.delete(fd);
      else if (typeof args[1] === 'function') {
        const cb = args[1];
        args[1] = function onClose(...cbArgs) { fdMap.delete(fd); return cb.apply(this, cbArgs); };
      }
      return original.apply(fs, args);
    };
  }

  if (typeof fs.createWriteStream === 'function') {
    const original = fs.createWriteStream;
    fs.createWriteStream = function patched(target, options) {
      if (options && typeof options === 'object' && Number.isInteger(options.fd)) guardFd(options.fd, 'fs.createWriteStream(fd)', { checkLinks: true });
      else guardWrite(target, 'fs.createWriteStream', { checkLinks: true });
      return original.call(fs, target, options);
    };
  }

  // fs.promises
  const promiseContent = ['writeFile', 'appendFile', 'truncate', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes'];
  for (const name of promiseContent) {
    const original = fsp[name];
    if (typeof original !== 'function') continue;
    fsp[name] = function patched(...args) {
      guardWrite(args[0], `fs.promises.${name}`, { checkLinks: true });
      return original.apply(fsp, args);
    };
  }
  const promiseCreate = ['mkdir', 'mkdtemp'];
  for (const name of promiseCreate) {
    const original = fsp[name];
    if (typeof original !== 'function') continue;
    fsp[name] = function patched(...args) {
      guardWrite(args[0], `fs.promises.${name}`);
      return original.apply(fsp, args);
    };
  }
  const promiseRemove = ['rm', 'rmdir', 'unlink'];
  for (const name of promiseRemove) {
    const original = fsp[name];
    if (typeof original !== 'function') continue;
    fsp[name] = function patched(...args) {
      guardWrite(args[0], `fs.promises.${name}`, { linkEntry: true });
      return original.apply(fsp, args);
    };
  }
  if (typeof fsp.rename === 'function') {
    const original = fsp.rename;
    fsp.rename = function patched(...args) {
      guardWrite(args[0], 'fs.promises.rename', { linkEntry: true });
      guardWrite(args[1], 'fs.promises.rename', { linkEntry: true });
      return original.apply(fsp, args);
    };
  }
  for (const name of ['copyFile', 'cp']) {
    const original = fsp[name];
    if (typeof original !== 'function') continue;
    fsp[name] = function patched(...args) {
      guardWrite(args[1], `fs.promises.${name}`, { checkLinks: true });
      return original.apply(fsp, args);
    };
  }
  if (typeof fsp.symlink === 'function') {
    const original = fsp.symlink;
    fsp.symlink = function patched(...args) {
      guardWrite(args[1], 'fs.promises.symlink');
      return original.apply(fsp, args);
    };
  }
  if (typeof fsp.link === 'function') {
    const original = fsp.link;
    fsp.link = async function patched(source, dest) {
      guardHardLink(source, dest, 'fs.promises.link');
      const result = await original.call(fsp, source, dest);
      trackCreatedHardlink(dest);
      return result;
    };
  }
  const origPromiseOpen = fsp.open;
  if (typeof origPromiseOpen === 'function') {
    fsp.open = async function patched(target, flags, mode) {
      const writable = flagsWritable(flags);
      if (writable) guardWrite(target, 'fs.promises.open', { checkLinks: true });
      const handle = await origPromiseOpen.call(fsp, target, flags, mode);
      const p = normalizePathArg(target);
      if (p != null) {
        const abs = path.resolve(p);
        fdMap.set(Number(handle.fd), abs);
        guardFileHandle(handle, abs);
      }
      return handle;
    };
  }
  // 同一对象若通过 fs.promises 暴露，也同步生效（Node 中二者通常是同一对象）
  try { if (fs.promises !== fsp) Object.assign(fs.promises, {}); } catch { /* ignore */ }
}

function guardFileHandle(handle, targetPath) {
  const methods = ['writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes'];
  for (const name of methods) {
    if (typeof handle[name] !== 'function') continue;
    const original = handle[name].bind(handle);
    try {
      Object.defineProperty(handle, name, {
        configurable: true,
        writable: true,
        value: (...args) => { guardWrite(targetPath, `FileHandle.${name}`, { checkLinks: true }); return original(...args); },
      });
    } catch { /* 不可写则忽略，open 时已按 flags 判定 */ }
  }
  if (typeof handle.createWriteStream === 'function') {
    const original = handle.createWriteStream.bind(handle);
    try {
      Object.defineProperty(handle, 'createWriteStream', {
        configurable: true,
        writable: true,
        value: (...args) => { guardWrite(targetPath, 'FileHandle.createWriteStream', { checkLinks: true }); return original(...args); },
      });
    } catch { /* ignore */ }
  }
  return handle;
}

// ── 网络判定 ─────────────────────────────────────────────────────────────────
const inProcessListeningPorts = new Set();

function readSelfPorts() {
  const ports = new Set(inProcessListeningPorts);
  try {
    const text = O.readFileSync(selfPortsFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const port = Number(rec?.port);
        if (Number.isInteger(port) && port > 0) ports.add(port);
      } catch { /* 忽略半行/坏行 */ }
    }
  } catch { /* 注册表尚不存在时只有本进程端口 */ }
  return ports;
}

function isRegisteredEndpoint(host, port) {
  const hostText = String(host ?? '').toLowerCase();
  return allowEndpoints.some((e) => e.port === Number(port) && (e.host === hostText || (isLoopbackHost(e.host) && isLoopbackHost(hostText))));
}

function networkAllowed(host, port) {
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return false;
  if (!host) return false;
  if (isRegisteredEndpoint(host, port)) return true;
  if (isLoopbackHost(host) && readSelfPorts().has(Number(port))) return true;
  return false;
}

function describeTarget(host, port) {
  return `${host}:${port}`;
}

function parseHttpTarget(args, defaultPort) {
  const first = args[0];
  if (first instanceof NodeURL || typeof first === 'string') {
    try {
      const url = new NodeURL(String(first));
      return { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : defaultPort)), display: url.href };
    } catch {
      return { host: '', port: 0, display: String(first) };
    }
  }
  const options = first && typeof first === 'object'
    ? first
    : (args[1] && typeof args[1] === 'object' ? args[1] : {});
  if (options.socketPath || (options.path && !options.host && !options.hostname && !options.port)) {
    return { host: '', port: 0, display: `unix:${options.socketPath ?? options.path}` };
  }
  if (options.href) {
    try {
      const url = new NodeURL(String(options.href));
      return { host: url.hostname, port: Number(url.port || defaultPort), display: url.href };
    } catch { /* ignore */ }
  }
  let host = options.hostname ?? options.host ?? 'localhost';
  let port = options.port;
  if (typeof host === 'string' && host.includes(':') && !host.startsWith('[')) {
    const idx = host.lastIndexOf(':');
    const hostPart = host.slice(0, idx);
    const portPart = host.slice(idx + 1);
    if (/^\d+$/.test(portPart)) { host = hostPart; if (port == null) port = portPart; }
  }
  const numericPort = Number(port ?? defaultPort);
  return { host: String(host), port: numericPort, display: `http://${host}:${numericPort}` };
}

function installHttpGuards() {
  for (const [module, label, defaultPort] of [[http, 'node:http', 80], [https, 'node:https', 443]]) {
    for (const name of ['request', 'get']) {
      const original = module[name];
      if (typeof original !== 'function') continue;
      module[name] = function patched(...args) {
        const target = parseHttpTarget(args, defaultPort);
        if (!networkAllowed(target.host, target.port)) {
          throw violation('network', `${label}.${name}`, { url: target.display, target: describeTarget(target.host, target.port) });
        }
        return original.apply(module, args);
      };
    }
  }
}

function installFetchGuards() {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = async function patchedFetch(input, init) {
      let url;
      try {
        const raw = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
        url = new NodeURL(String(raw));
      } catch {
        throw violation('network', 'globalThis.fetch', { url: String(input).slice(0, 300), reason: 'unparsable-url' });
      }
      if (url.protocol === 'data:' || url.protocol === 'blob:') return originalFetch.call(globalThis, input, init);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw violation('network', 'globalThis.fetch', { url: url.href, reason: 'unsupported-protocol' });
      }
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!networkAllowed(url.hostname, port)) {
        throw violation('network', 'globalThis.fetch', { url: url.href, target: describeTarget(url.hostname, port) });
      }
      return originalFetch.call(globalThis, input, init);
    };
  }
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    globalThis.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        let url;
        try { url = new NodeURL(String(args[0])); } catch {
          throw violation('network', 'globalThis.WebSocket', { url: String(args[0]).slice(0, 300), reason: 'unparsable-url' });
        }
        const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
        if (!networkAllowed(url.hostname, port)) {
          throw violation('network', 'globalThis.WebSocket', { url: url.href, target: describeTarget(url.hostname, port) });
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
}

function parseSocketTarget(api, args) {
  let first = args[0];
  // Node 内部/undici 有时把 normalizeArgs 的结果作为单一数组参数传入。
  if (Array.isArray(first)) return parseSocketTarget(api, first);
  if (first && typeof first === 'object'
    && !('host' in first) && !('hostname' in first) && !('port' in first)
    && !('path' in first) && !('socketPath' in first) && first[0]) {
    return parseSocketTarget(api, Array.from(first));
  }
  if (first && typeof first === 'object') {
    if (first.path || first.socketPath) return { kind: 'unix', display: `unix:${first.path ?? first.socketPath}` };
    const host = first.host ?? first.hostname ?? 'localhost';
    return { kind: 'tcp', host: String(host), port: Number(first.port) };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { kind: 'tcp', host: String(host), port: Number(first) };
  }
  return { kind: 'unix', display: `unix:${String(first)}` };
}

function installNetGuards() {
  const originalConnect = net.connect;
  net.connect = function patched(...args) {
    const target = parseSocketTarget('node:net.connect', args);
    if (target.kind !== 'tcp' || !networkAllowed(target.host, target.port)) {
      throw violation('network', 'node:net.connect', { target: target.kind === 'tcp' ? describeTarget(target.host, target.port) : target.display });
    }
    return originalConnect.apply(net, args);
  };
  if (typeof net.createConnection === 'function') {
    const originalCreateConnection = net.createConnection;
    net.createConnection = function patched(...args) {
      const target = parseSocketTarget('node:net.createConnection', args);
      if (target.kind !== 'tcp' || !networkAllowed(target.host, target.port)) {
        throw violation('network', 'node:net.createConnection', { target: target.kind === 'tcp' ? describeTarget(target.host, target.port) : target.display });
      }
      return originalCreateConnection.apply(net, args);
    };
  }
  if (net.Socket && net.Socket.prototype && typeof net.Socket.prototype.connect === 'function') {
    const originalSocketConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function patched(...args) {
      const target = parseSocketTarget('net.Socket.connect', args);
      if (target.kind !== 'tcp' || !networkAllowed(target.host, target.port)) {
        throw violation('network', 'net.Socket.connect', { target: target.kind === 'tcp' ? describeTarget(target.host, target.port) : target.display });
      }
      return originalSocketConnect.apply(this, args);
    };
  }
  if (tls && typeof tls.connect === 'function') {
    const originalTlsConnect = tls.connect;
    tls.connect = function patched(...args) {
      const target = parseSocketTarget('node:tls.connect', args);
      if (target.kind !== 'tcp' || !networkAllowed(target.host, target.port)) {
        throw violation('network', 'node:tls.connect', { target: target.kind === 'tcp' ? describeTarget(target.host, target.port) : target.display });
      }
      return originalTlsConnect.apply(tls, args);
    };
  }
  // 记录本 run 内任意进程 listen 的端口（共享注册表 self-ports.jsonl）
  if (net.Server && net.Server.prototype && typeof net.Server.prototype.listen === 'function') {
    const originalListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function patched(...args) {
      const server = this;
      const record = () => {
        try {
          const address = server.address();
          if (!address || typeof address !== 'object' || !Number.isInteger(Number(address.port)) || Number(address.port) <= 0) return;
          const boundHost = String(address.address ?? '');
          const wildcard = boundHost === '0.0.0.0' || boundHost === '::' || boundHost === '';
          if (!isLoopbackHost(boundHost) && !wildcard) return; // 仅登记 loopback/本机通配绑定
          inProcessListeningPorts.add(Number(address.port));
          rawAppend(selfPortsFile, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, port: Number(address.port), address: boundHost })}\n`);
        } catch { /* 注册失败不影响 server 本身；connect 时仍可用 inProcessListeningPorts */ }
      };
      try { server.once('listening', record); } catch { /* ignore */ }
      return originalListen.apply(server, args);
    };
  }
}

// ── C03：受控子进程 / worker 创建 ───────────────────────────────────────────
// 隔离不能由用例可删除的环境变量决定：Node 后代强制可信 execPath + --import preload +
// 强制 A00_ISOLATION_POLICY/NODE_OPTIONS；非 Node、shell:true、字符串 shell 命令在副作用前拒绝。
function isNodeExecutable(command) {
  if (typeof command !== 'string') return false;
  const lowered = command.toLowerCase();
  if (lowered === 'node' || lowered === 'node.exe') return true;
  const base = path.basename(lowered);
  if (base === 'node' || base === 'node.exe') return true;
  try { if (samePath(command, process.execPath)) return true; } catch { /* ignore */ }
  return false;
}

function forceChildEnv(baseEnv) {
  // 合并 process.env 保证子进程能启动；但隔离相关变量一律由我们覆盖。
  const env = { ...process.env, ...(baseEnv && typeof baseEnv === 'object' ? baseEnv : {}) };
  Object.assign(env, FORCED_CHILD_ENV);
  const existing = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : '';
  env.NODE_OPTIONS = existing.includes(PRELOAD_URL) ? existing : `${existing} ${NODE_OPTIONS_INJECT}`.trim();
  return env;
}

function rejectChildProcess(api, command, reason) {
  throw violation('process', api, { target: String(command).slice(0, 300), reason });
}

function installChildProcessGuards() {
  const CP = {
    spawn: childProcess.spawn.bind(childProcess),
    spawnSync: childProcess.spawnSync.bind(childProcess),
    exec: childProcess.exec.bind(childProcess),
    execSync: childProcess.execSync.bind(childProcess),
    execFile: childProcess.execFile.bind(childProcess),
    execFileSync: childProcess.execFileSync.bind(childProcess),
    fork: childProcess.fork.bind(childProcess),
  };

  const patchSpawnLike = (name) => {
    childProcess[name] = function patched(command, argsOrOptions, maybeOptions) {
      let args = [];
      let options = {};
      if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions;
        options = maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {};
      } else if (argsOrOptions && typeof argsOrOptions === 'object') {
        options = argsOrOptions;
      } else if (maybeOptions && typeof maybeOptions === 'object') {
        options = maybeOptions;
      }
      if (options.shell) rejectChildProcess(`child_process.${name}`, command, 'shell-not-allowed');
      if (!isNodeExecutable(command)) rejectChildProcess(`child_process.${name}`, command, 'non-node-child-process-rejected');
      return CP[name].call(childProcess, process.execPath, ['--import', PRELOAD_URL, ...args.map((a) => String(a))], {
        ...options,
        env: forceChildEnv(options.env),
      });
    };
  };
  patchSpawnLike('spawn');
  patchSpawnLike('spawnSync');

  // exec/execSync 都是字符串 shell 命令：无法保证强制可信入口 => 一律拒绝。
  for (const name of ['exec', 'execSync']) {
    childProcess[name] = function patched(command) {
      rejectChildProcess(`child_process.${name}`, command, 'string-shell-command-rejected');
      return undefined;
    };
  }

  const normalizeExecFileArgs = (rest) => {
    let args = [];
    let idx = 0;
    if (Array.isArray(rest[0])) { args = rest[0]; idx = 1; }
    let options = {};
    if (rest[idx] && typeof rest[idx] === 'object' && typeof rest[idx] !== 'function') { options = rest[idx]; idx += 1; }
    const callback = typeof rest[idx] === 'function' ? rest[idx] : (typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : undefined);
    return { args, options, callback };
  };
  for (const name of ['execFile', 'execFileSync']) {
    childProcess[name] = function patched(file, ...rest) {
      const { args, options, callback } = normalizeExecFileArgs(rest);
      if (options.shell) rejectChildProcess(`child_process.${name}`, file, 'shell-not-allowed');
      if (!isNodeExecutable(file)) rejectChildProcess(`child_process.${name}`, file, 'non-node-child-process-rejected');
      const callArgs = [process.execPath, ['--import', PRELOAD_URL, ...args.map((a) => String(a))], { ...options, env: forceChildEnv(options.env) }];
      if (name === 'execFile' && typeof callback === 'function') callArgs.push(callback);
      return CP[name].call(childProcess, ...callArgs);
    };
  }

  childProcess.fork = function patched(modulePath, argsOrOptions, maybeOptions) {
    let args = [];
    let options = {};
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions;
      options = maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {};
    } else if (argsOrOptions && typeof argsOrOptions === 'object') {
      options = argsOrOptions;
    }
    const execArgv = Array.isArray(options.execArgv) ? [...options.execArgv] : [];
    if (!execArgv.some((a) => String(a).includes(PRELOAD_URL))) execArgv.push('--import', PRELOAD_URL);
    return CP.fork.call(childProcess, modulePath, args, {
      ...options,
      execPath: process.execPath,
      execArgv,
      env: forceChildEnv(options.env),
    });
  };
}

function installWorkerGuards() {
  if (!workerThreads || typeof workerThreads.Worker !== 'function') return;
  const OriginalWorker = workerThreads.Worker;
  function PatchedWorker(filename, options) {
    const opts = options && typeof options === 'object' ? { ...options } : {};
    const execArgv = Array.isArray(opts.execArgv) ? [...opts.execArgv] : [...process.execArgv];
    if (!execArgv.some((a) => String(a).includes(PRELOAD_URL))) execArgv.push('--import', PRELOAD_URL);
    opts.execArgv = execArgv;
    opts.env = forceChildEnv(opts.env === workerThreads.SHARE_ENV ? process.env : opts.env);
    let workerSource = filename;
    // execArgv 的 --import 对 eval:true worker 不生效（实测），改为在 CJS eval 源码前同步 require preload。
    if (opts.eval === true && typeof filename === 'string') {
      workerSource = `require(${JSON.stringify(PRELOAD_FILE_PATH)});\n${filename}`;
    }
    return new OriginalWorker(workerSource, opts);
  }
  try {
    Object.setPrototypeOf(PatchedWorker, OriginalWorker);
    PatchedWorker.prototype = OriginalWorker.prototype;
    workerThreads.Worker = PatchedWorker;
  } catch (error) {
    throw violation('process', 'worker_threads.Worker', { reason: 'worker-guard-install-failed', detail: String(error?.message ?? error) });
  }
}

// 供测试脚本自检用的最小诊断入口（不暴露可绕过能力）
try {
  Object.defineProperty(globalThis, '__A00_ISOLATION__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      version: 'A00-rework2',
      policyPath,
      dataRoot: dataRootReal,
      writeRoots: Object.freeze([...writeRoots]),
      allowEndpoints: Object.freeze(allowEndpoints.map((e) => `${e.host}:${e.port}`)),
      registeredSelfPorts: () => [...readSelfPorts()],
      violationsFile,
      guards: Object.freeze({ hardlink: true, noPermanentPathCache: true, childProcess: true, workerThreads: true }),
    }),
  });
} catch { /* ignore */ }

installFsGuards();
installHttpGuards();
installFetchGuards();
installNetGuards();
installChildProcessGuards();
installWorkerGuards();

if (process.env.A00_ISOLATION_DEBUG === '1') {
  try {
    process.stderr.write(`[a00-isolation] active pid=${process.pid} dataRoot=${dataRootReal}\n`);
  } catch { /* ignore */ }
}
