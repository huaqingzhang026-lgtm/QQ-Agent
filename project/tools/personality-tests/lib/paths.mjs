// A00-rework1 路径安全库（B01）。
//
// 设计约束：
//  - 只 import node:path / node:url，**不 import node:fs**。这样 isolation/preload.mjs
//    可以在 patch node:fs 之前用注入的 fs 实现调用本库，避免 ESM 内置模块命名导出快照问题。
//  - 所有函数是纯函数（除传入的 fsImpl 外无副作用），方便 runner 与 preload 共用。
//
// 覆盖：Windows 大小写归一、相对路径解析、最近存在祖先 realpath、junction/symlink
// 别名（含中间目录）、同源输入/输出检测、isInside 边界。
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

// 归一为可比较的绝对路径：resolve + 正斜杠 + 去尾分隔符 + Windows 小写。
export function comparable(target) {
  let s = path.resolve(String(target));
  s = toPosix(s);
  s = s.replace(/\/+$/, '');
  if (s === '') s = '/';
  return IS_WINDOWS ? s.toLowerCase() : s;
}

export function samePath(a, b) {
  if (a == null || b == null) return false;
  return comparable(a) === comparable(b);
}

// parent 是否包含 child（含相等）。大小写/分隔符归一；不做字符串朴素前缀。
export function isInside(parent, child) {
  if (parent == null || child == null) return false;
  const p = comparable(parent);
  const c = comparable(child);
  if (p === c) return true;
  const prefix = p.endsWith('/') ? p : p + '/';
  return c.startsWith(prefix);
}

// 两个路径是否存在包含/相同关系（任一方向）。
export function overlaps(a, b) {
  return isInside(a, b) || isInside(b, a);
}

function statFollow(fsImpl, target) {
  try {
    if (typeof fsImpl.statSync === 'function') return fsImpl.statSync(target);
    return fsImpl.lstatSync(target);
  } catch {
    return null;
  }
}

function realpathOf(fsImpl, target) {
  const fn = fsImpl.realpathSync;
  if (typeof fn !== 'function') return null;
  try {
    const native = fn.native;
    if (typeof native === 'function') {
      try { return native.call(fn, target); } catch { /* fall through */ }
    }
    return fn.call(fsImpl, target);
  } catch {
    return null;
  }
}

// 找到 target 最近的存在祖先（stat 跟随 symlink/junction）。
// 返回 { ancestor, tail: string[], exists, isDirectory }。
export function nearestExistingAncestor(fsImpl, target) {
  let cur = path.resolve(String(target));
  const tail = [];
  for (;;) {
    const st = statFollow(fsImpl, cur);
    if (st) {
      return { ancestor: cur, tail, exists: tail.length === 0, isDirectory: st.isDirectory() };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return { ancestor: cur, tail, exists: false, isDirectory: false };
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

// 解析“最终真实目标”：
//  - 已存在 -> 直接 realpath（解析 junction/symlink，含大小写真值）
//  - 不存在 -> 最近存在祖先 realpath + 剩余段（按声明大小写拼接）
// 返回 { declared, real, existed, invalid, existingAncestor }。
export function resolveRealTarget(fsImpl, target) {
  const declared = path.resolve(String(target));
  const direct = realpathOf(fsImpl, declared);
  if (direct != null) {
    return { declared, real: direct, existed: true, invalid: null, existingAncestor: declared };
  }
  const anc = nearestExistingAncestor(fsImpl, declared);
  if (anc.tail.length > 0 && !anc.isDirectory) {
    return { declared, real: null, existed: false, invalid: 'existing-ancestor-not-a-directory', existingAncestor: anc.ancestor };
  }
  const ancReal = realpathOf(fsImpl, anc.ancestor);
  if (ancReal == null) {
    return { declared, real: null, existed: false, invalid: 'ancestor-realpath-failed', existingAncestor: anc.ancestor };
  }
  const real = anc.tail.length ? path.join(ancReal, ...anc.tail) : ancReal;
  return { declared, real, existed: anc.exists, invalid: null, existingAncestor: anc.ancestor };
}

export function isDirectory(fsImpl, target) {
  const st = statFollow(fsImpl, path.resolve(String(target)));
  return Boolean(st && st.isDirectory());
}

export function relat(base, target) {
  return toPosix(path.relative(path.resolve(String(base)), path.resolve(String(target))));
}

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// 把 argv 参数归类：url / absolute-path / relative-path-candidate / flag / other。
// 是否“确实像路径”还要结合 cwd 存在性判断，由 runner 决定。
export function classifyArg(arg) {
  if (typeof arg !== 'string') return { kind: 'other', value: arg };
  if (URL_LIKE.test(arg)) return { kind: 'url', value: arg };
  if (arg.startsWith('-') && !arg.includes('/') && !arg.includes('\\')) return { kind: 'flag', value: arg };
  if (/^[a-zA-Z]:[\\/]/.test(arg) || arg.startsWith('\\\\') || arg.startsWith('//')) {
    return { kind: 'absolute-path', value: arg };
  }
  if (arg.includes('/') || arg.includes('\\')) return { kind: 'relative-path', value: arg };
  return { kind: 'other', value: arg };
}

// 生产启动器识别（相对路径、绝对路径、正反斜杠都按同一规则识别）。
// 命中即拒绝整个 run（不是静默跳过），见 run.mjs preflight。
export function productionLauncherKind(target) {
  if (target == null) return null;
  const p = toPosix(target).toLowerCase();
  const base = p.split('/').pop() ?? p;
  if (p.includes('/tools/hidden/') || p.startsWith('tools/hidden/')) return 'tools/hidden/**';
  if (/^run-.*\.(cmd|bat|ps1|vbs)$/.test(base)) return 'run-*.cmd';
  if (/^start-.*\.(cmd|bat|ps1|vbs)$/.test(base)) return 'start-*.cmd';
  if (/^stop-.*\.(cmd|bat|ps1|vbs)$/.test(base)) return 'stop-*.cmd';
  if (/^restart\.(cmd|bat|ps1|vbs)$/.test(base)) return 'restart.cmd';
  if (/^start\.(cmd|bat|ps1|vbs)$/.test(base)) return 'start.cmd';
  if (base === 'send-qq.mjs') return 'send-qq.mjs';
  if (base === 'life-loop.mjs') return 'life-loop.mjs';
  if (/\/qq-bridge\/src\/bridge\.js$/.test(p) || p === 'qq-bridge/src/bridge.js') return 'qq-bridge/src/bridge.js';
  return null;
}

// 用例 id 必须可以安全地作为日志文件名的一部分。
export function isValidCaseId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
}

export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// "host:port"（也接受 [::1]:port）。返回 {host, port} 或 null。
export function parseEndpoint(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.trim();
  const m = s.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (m) {
    const port = Number(m[2]);
    return port >= 1 && port <= 65535 ? { host: m[1].toLowerCase(), port } : null;
  }
  const idx = s.lastIndexOf(':');
  if (idx <= 0 || idx === s.length - 1) return null;
  const host = s.slice(0, idx).toLowerCase();
  const port = Number(s.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export const PLATFORM = { isWindows: IS_WINDOWS };
