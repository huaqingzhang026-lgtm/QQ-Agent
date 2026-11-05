// Android emulator bridge via adb (no root, no shell passthrough).
// MCP stdio server; deliberately exposes only screen/UI + basic touch.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONF = path.join(ROOT, 'android-mcp', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONF, 'utf8').replace(/^\uFEFF/, ''));
const ADB = String(cfg.adb || 'adb');
const SERIAL = String(cfg.serial || '127.0.0.1:7555');
const SHOTS = path.resolve(ROOT, cfg.screenshotDir || 'state/android');
fs.mkdirSync(SHOTS, { recursive: true });
const allow = new Set((cfg.allowPackages || []).map(String));
const CONTROL = path.resolve(ROOT, cfg.controlFile || 'qq-bridge/state/android-control.json');
const AUDIT = path.resolve(ROOT, cfg.auditFile || 'qq-bridge/state/android-audit.jsonl');
const FILES = path.resolve(ROOT, cfg.filesDir || 'android-mcp/files');
fs.mkdirSync(FILES, { recursive: true });
function ownerToken() {
  try {
    const s = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'qq-bridge', 'state', 'social-v2.json'), 'utf8'));
    let ownerQQ = cfg.ownerQQ;
    if (!ownerQQ) { try { ownerQQ = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'qq-bridge', 'config.json'), 'utf8')).ownerQQ; } catch {} }
    return String(s?.conversations?.['private:' + String(ownerQQ || '')]?.agentToken || '');
  } catch { return ''; }
}
function ownerTokenOk(token) {
  const want = ownerToken();
  return !!want && String(token || '') === want;
}
function fullControlOk(token) {
  if (cfg.fullControl !== true) return false;
  if (!ownerTokenOk(token)) return false;
  try { const c = JSON.parse(fs.readFileSync(CONTROL, 'utf8')); return Number(c.until) > Date.now(); } catch { return false; }
}
function audit(action, args, result) {
  try { fs.appendFileSync(AUDIT, JSON.stringify({ at: Date.now(), action, args, ok: !!result?.ok, output: String(result?.stdout || result?.error || '').slice(0, 600) }) + '\n', 'utf8'); } catch {}
}
function forbidden(command) {
  return /\b(su|magisk)\b|password|passwd|改密|支付|付款|充值|alipay|wechat.?pay|注销账号|删除账号|cmd account/i.test(String(command || ''));
}
function destructive(command) {
  return /\bpm\s+(uninstall|clear)\b|\bsettings\s+put\b|\brm\s+-rf\b|\bcmd\s+clipboard\s+set\b|\bam\s+(force-stop|disable)\b/i.test(String(command || ''));
}

let actions = [];

function run(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(ADB, ['-s', SERIAL, ...args], { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err?.message || '' });
    });
  });
}
function rateOk() {
  const now = Date.now();
  actions = actions.filter((t) => now - t < 60000);
  if (actions.length >= Number(cfg.maxActionsPerMinute || 40)) return false;
  actions.push(now);
  return true;
}
function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function dumpUi() {
  const dump = await run(['shell', 'uiautomator', 'dump', '/sdcard/window.xml']);
  if (!dump.ok && !/dumped to/i.test(dump.stdout)) return { ok: false, error: dump.stderr || dump.error };
  const cat = await run(['shell', 'cat', '/sdcard/window.xml']);
  if (!cat.ok) return { ok: false, error: cat.stderr || cat.error };
  const xml = cat.stdout;
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) && nodes.length < 120) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    if (!(attrs.text || attrs['content-desc'] || attrs['resource-id'])) continue;
    nodes.push({
      text: attrs.text || '',
      desc: attrs['content-desc'] || '',
      id: attrs['resource-id'] || '',
      cls: attrs.class || '',
      clickable: attrs.clickable === 'true',
      bounds: attrs.bounds || '',
    });
  }
  return { ok: true, xml, nodes };
}
function center(bounds) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds || '');
  if (!m) return null;
  return { x: Math.round((+m[1] + +m[3]) / 2), y: Math.round((+m[2] + +m[4]) / 2) };
}

async function screenshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(SHOTS, `android-${stamp}.png`);
  const r = await new Promise((resolve) => {
    execFile(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeout: 30000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  if (r.err) return { ok: false, error: String(r.err.message || r.err) };
  fs.writeFileSync(file, r.stdout);
  return { ok: true, file: path.relative(ROOT, file), bytes: r.stdout.length };
}

const TOOLS = [
  { name: 'android_devices', description: '列出 adb 设备，并检查模拟器是否在线。', inputSchema: { type: 'object', properties: {} } },
  { name: 'android_screenshot', description: '截取当前模拟器屏幕，返回本地文件路径。适合视觉判断，不要每步都截。', inputSchema: { type: 'object', properties: {} } },
  { name: 'android_ui_dump', description: '读取当前界面控件树（文字/描述/资源 id/bounds）。优先用它找控件，不要盲点坐标。', inputSchema: { type: 'object', properties: {} } },
  { name: 'android_tap', description: '点击坐标，或按控件文字/描述点击。传 text 时自动从 UI 树找中心点。', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } } } },
  { name: 'android_swipe', description: '滑动屏幕。', inputSchema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'android_input_text', description: '向当前焦点输入文字（仅 ASCII/数字更稳）。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'android_key', description: '按系统键：back/home/recents/enter。', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'android_launch_app', description: '启动白名单 App。B站=tv.danmaku.bili，小红书=com.xingin.xhs。', inputSchema: { type: 'object', properties: { package: { type: 'string' } }, required: ['package'] } },
  { name: 'android_shell', description: '系统级 adb shell（完整权限；支付/改密/删账号永久禁止；破坏性命令需 confirm=true）', inputSchema: { type: 'object', properties: { command: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['command', 'token'] } },
  { name: 'android_install', description: '安装 APK；破坏性操作，confirm=true', inputSchema: { type: 'object', properties: { apk: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['apk', 'token'] } },
  { name: 'android_uninstall', description: '卸载 App；破坏性操作，confirm=true', inputSchema: { type: 'object', properties: { package: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['package', 'token'] } },
  { name: 'android_push', description: '推送本地文件到模拟器；confirm=true', inputSchema: { type: 'object', properties: { local: { type: 'string' }, remote: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['local', 'remote', 'token'] } },
  { name: 'android_pull', description: '从模拟器拉取文件到本地；confirm=true', inputSchema: { type: 'object', properties: { remote: { type: 'string' }, local: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['remote', 'local', 'token'] } },
  { name: 'android_settings', description: '读写系统设置；写操作需 confirm=true', inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['namespace', 'key', 'token'] } },
  { name: 'android_clipboard', description: '读取/设置剪贴板；设置需 confirm=true', inputSchema: { type: 'object', properties: { action: { type: 'string' }, text: { type: 'string' }, confirm: { type: 'boolean' }, token: { type: 'string' } }, required: ['action', 'token'] } },
  { name: 'android_current_app', description: '当前前台包名/Activity。', inputSchema: { type: 'object', properties: {} } },
  { name: 'android_feed_scan', description: '读当前推荐流/列表里看得见的标题和文本，返回 text/bounds。适合 B站/小红书刷推荐时挑内容。', inputSchema: { type: 'object', properties: {} } },
  { name: 'android_feed_scroll', description: '推荐流下滑一屏，模拟自然浏览。', inputSchema: { type: 'object', properties: {} } },
];

async function call(name, args = {}) {
  if (actions.length >= 0 && !['android_devices', 'android_screenshot', 'android_ui_dump', 'android_current_app'].includes(name) && !rateOk()) {
    return { ok: false, error: '操作过快，已限流（40 次/分钟）' };
  }
  if (name === 'android_devices') {
    const r = await run(['devices']);
    return { ok: r.ok, devices: r.stdout, error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_screenshot') return screenshot();
  if (name === 'android_ui_dump') {
    const r = await dumpUi();
    return r.ok ? { ok: true, nodes: r.nodes } : r;
  }
  if (name === 'android_tap') {
    let x = Number(args.x), y = Number(args.y);
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && args.text) {
      const r = await dumpUi();
      if (!r.ok) return r;
      const n = r.nodes.find((v) => (v.text && v.text.includes(String(args.text))) || (v.desc && v.desc.includes(String(args.text))));
      const c = n && center(n.bounds);
      if (!c) return { ok: false, error: '界面里没找到：' + args.text };
      x = c.x; y = c.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '需要 x/y 或 text' };
    const r = await run(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
    return { ok: r.ok, x: Math.round(x), y: Math.round(y), error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_swipe') {
    const r = await run(['shell', 'input', 'swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2), String(args.duration || 300)]);
    return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_input_text') {
    const text = String(args.text || '').slice(0, 200);
    const r = await run(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
    return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_key') {
    const map = { back: 4, home: 3, recents: 187, enter: 66 };
    const code = map[String(args.key || '').toLowerCase()];
    if (!code) return { ok: false, error: '只支持 back/home/recents/enter' };
    const r = await run(['shell', 'input', 'keyevent', String(code)]);
    return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_launch_app') {
    const pkg = String(args.package || '');
    if (!allow.has(pkg)) return { ok: false, error: '不在白名单：' + pkg };
    const r = await run(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    return { ok: r.ok, package: pkg, output: r.stdout.slice(-500), error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_feed_scan') {
    const r = await dumpUi();
    if (!r.ok) return r;
    const seen = new Set();
    const items = [];
    for (const n of r.nodes) {
      const s = String(n.text || n.desc || '').trim();
      if (s.length < 4 || s.length > 120) continue;
      if (/^(赞|评论|收藏|分享|首页|关注|发现|推荐|直播|热门|消息|我|返回|搜索|\d+[万亿]?|\d+:\d+)$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      items.push({ text: s, bounds: n.bounds, clickable: n.clickable });
      if (items.length >= 40) break;
    }
    return { ok: true, items };
  }
  if (name === 'android_feed_scroll') {
    const r = await run(['shell', 'input', 'swipe', '720', '2000', '720', '650', '650']);
    return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.error };
  }
  if (name === 'android_shell') {
    if (!fullControlOk(args.token)) return { ok: false, error: '系统级控制未授权：需要主人私聊会话令牌' };
    const command = String(args.command || '').trim();
    if (!command) return { ok: false, error: 'command 不能为空' };
    if (forbidden(command)) return { ok: false, error: '命令包含永久禁止的操作（支付/改密码/删除账号/root）' };
    if (destructive(command) && args.confirm !== true) return { ok: false, error: '破坏性命令需要 confirm=true' };
    const r = await run(['shell', command], 120000);
    audit('shell', { command }, r);
    return { ok: r.ok, output: r.stdout.slice(-4000), error: r.ok ? undefined : (r.stderr || r.error) };
  }
  if (name === 'android_install') {
    if (!fullControlOk(args.token)) return { ok: false, error: '系统级控制未授权：需要主人私聊会话令牌' };
    if (args.confirm !== true) return { ok: false, error: '安装需要 confirm=true' };
    const apk = path.resolve(ROOT, String(args.apk || ''));
    if (!fs.existsSync(apk)) return { ok: false, error: 'APK 不存在：' + apk };
    const r = await run(['install', '-r', apk], 180000);
    audit('install', { apk }, r);
    return { ok: r.ok, output: r.stdout.slice(-1000), error: r.ok ? undefined : (r.stderr || r.error) };
  }
  if (name === 'android_uninstall') {
    if (!fullControlOk(args.token)) return { ok: false, error: '系统级控制未授权：需要主人私聊会话令牌' };
    if (args.confirm !== true) return { ok: false, error: '卸载需要 confirm=true' };
    const pkg = String(args.package || '').trim();
    if (!/^[\w.]+$/.test(pkg)) return { ok: false, error: 'package 格式无效' };
    const r = await run(['uninstall', pkg], 60000);
    audit('uninstall', { package: pkg }, r);
    return { ok: r.ok, output: r.stdout.slice(-1000), error: r.ok ? undefined : (r.stderr || r.error) };
  }
  if (name === 'android_push' || name === 'android_pull') {
    if (!fullControlOk(args.token)) return { ok: false, error: '系统级控制未授权：需要主人私聊会话令牌' };
    if (args.confirm !== true) return { ok: false, error: '文件传输需要 confirm=true' };
    const local = path.resolve(ROOT, String(args.local || ''));
    const remote = String(args.remote || '');
    if (!remote) return { ok: false, error: 'remote 不能为空' };
    const r = name === 'android_push' ? await run(['push', local, remote], 120000) : await run(['pull', remote, local], 120000);
    audit(name, { local, remote }, r);
    return { ok: r.ok, output: (r.stdout || '').slice(-1000), error: r.ok ? undefined : (r.stderr || r.error) };
  }
  if (name === 'android_settings') {
    if (!fullControlOk(args.token)) return { ok: false, error: '系统级控制未授权：需要主人私聊会话令牌' };
    const ns = String(args.namespace || '').trim();
    const key = String(args.key || '').trim();
    if (!/^[a-z_]+$/.test(ns) || !/^[\w.-]+$/.test(key)) return { ok: false, error: 'namespace/key 格式无效' };
    const hasValue = args.value !== undefined && args.value !== null;
    if (hasValue && args.confirm !== true) return { ok: false, error: '写系统设置需要 confirm=true' };
    const r = hasValue ? await run(['shell', 'settings', 'put', ns, key, String(args.value)], 30000) : await run(['shell', 'settings', 'get', ns, key], 30000);
    audit('settings', { namespace: ns, key, value: hasValue ? String(args.value) : null }, r);
    return { ok: r.ok, output: r.stdout.trim(), error: r.ok ? undefined : (r.stderr || r.error) };
  }
  if (name === 'android_clipboard') {
    if (!fullControlOk(args.token)) return { ok: false, error: '系统级控制未授权：需要主人私聊会话令牌' };
    const action = String(args.action || 'get').toLowerCase();
    if (action === 'set') {
      if (args.confirm !== true) return { ok: false, error: '设置剪贴板需要 confirm=true' };
      const r = await run(['shell', 'cmd', 'clipboard', 'set', String(args.text || '')], 30000);
      audit('clipboard.set', { text: String(args.text || '').slice(0, 200) }, r);
      return { ok: r.ok, output: r.stdout.trim(), error: r.ok ? undefined : (r.stderr || r.error) };
    }
    const r = await run(['shell', 'cmd', 'clipboard', 'get'], 30000);
    audit('clipboard.get', {}, r);
    return { ok: r.ok, output: r.stdout.trim(), error: r.ok ? undefined : (r.stderr || r.error) };
  }
  if (name === 'android_current_app') {
    const r = await run(['shell', 'dumpsys', 'window']);
    const m = /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/]+)\/([^}]+)\}/.exec(r.stdout);
    return { ok: r.ok, package: m?.[1] || '', activity: m?.[2] || '', error: r.ok ? undefined : r.stderr || r.error };
  }
  return { ok: false, error: 'unknown tool: ' + name };
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const raw = line.trim(); if (!raw) return;
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  const { id, method, params } = msg; if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'android-mcp', version: '1.0.0' } } });
    if (method === 'notifications/initialized') return;
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const r = await call(params?.name, params?.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }] } });
  }
});
