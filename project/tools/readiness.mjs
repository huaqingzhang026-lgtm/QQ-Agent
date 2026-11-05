// Readiness 探针（S5.3）：端口 + 依赖可用性，输出 state/readiness.json。
// 用法：node tools/readiness.mjs [--json]
// 退出码：0 全部健康；2 有降级/失败（供看门狗使用）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../qq-bridge/src/health.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const OUT = path.join(STATE, 'readiness.json');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };

const checks = [];
const add = (name, ok, detail, extra = {}) => checks.push({ name, ok, detail, ...extra });

const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const onebotBase = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken ?? '';

async function httpJson(url, opts = {}, timeoutMs = 5000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

// 1) SnowLuma WebUI
try {
  const r = await httpJson('http://127.0.0.1:5099/');
  add('snowluma-webui', r.status === 200 && r.text.length > 200, `HTTP ${r.status}`, { task: 'HerSnowLuma' });
} catch (e) { add('snowluma-webui', false, `unreachable: ${e.message}`, { task: 'HerSnowLuma' }); }

// 2) OneBot HTTP（QQ 已登录才可用）
let qqLoggedIn = false;
try {
  const r = await httpJson(`${onebotBase}/get_login_info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  });
  const uid = r.json?.data?.user_id;
  qqLoggedIn = r.json?.status === 'ok' && Number(uid) > 0;
  add('qq-login', qqLoggedIn, qqLoggedIn ? `uin ${uid}` : `status=${r.json?.status ?? r.status}`, { task: 'HerSnowLuma' });
  add('onebot-http', true, `HTTP ${r.status}`);
} catch (e) {
  add('qq-login', false, `unreachable: ${e.message}`, { task: 'HerSnowLuma' });
  add('onebot-http', false, `unreachable: ${e.message}`, { task: 'HerSnowLuma' });
}

// 3) OneBot WS 端口（3001 在监听即可）
try {
  const r = await fetch('http://127.0.0.1:5099/', { signal: AbortSignal.timeout(3000) });
  add('onebot-ws-port', r.ok, 'via 5099 probe', { required: false });
} catch { add('onebot-ws-port', false, 'probe failed', { required: false }); }

// 4) 她的 DSH：日志里有 token 行 + Web 可打开
try {
  const log = fs.readFileSync(path.join(ROOT, 'dsh-web-3080.log'), 'utf8');
  const hasToken = /dsh web: http:\/\/127\.0\.0\.1:3080\/\?token=/.test(log);
  add('dsh-initialized', hasToken, hasToken ? 'token line present' : 'no token line (MCP hang?)', { task: 'HerDSH' });
} catch (e) { add('dsh-initialized', false, `log unreadable: ${e.message}`, { task: 'HerDSH' }); }

try {
  const r = await httpJson('http://127.0.0.1:3080/', {}, 4000).catch((e) => ({ status: 0, text: '', json: null, err: e }));
  const ok = r.status === 200 || r.status === 303 || r.status === 401;
  add('dsh-http', ok, `HTTP ${r.status || 'ERR'}`, { task: 'HerDSH' });
} catch (e) { add('dsh-http', false, e.message, { task: 'HerDSH' }); }

// 5) 桥接：端口 + 最近日志是否显示 DSH 已就绪
try {
  const r = await httpJson('http://127.0.0.1:3100/api/status', { headers: token ? { 'x-console-token': token } : {} }, 4000);
  add('bridge-http', r.status === 200 || r.status === 401, `HTTP ${r.status}`, { task: 'HerBridge' });
} catch (e) { add('bridge-http', false, `unreachable: ${e.message}`, { task: 'HerBridge' }); }

try {
  const logPath = path.join(STATE, 'bridge.log');
  const stat = fs.statSync(logPath);
  const size = stat.size;
  const fd = fs.openSync(logPath, 'r');
  const len = Math.min(size, 12000);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
  fs.closeSync(fd);
  const tail = buf.toString('utf8');
  const readyAt = tail.lastIndexOf('DSH 已就绪');
  const afterReady = readyAt >= 0 ? tail.slice(readyAt) : '';
  // 流断开后能恢复/重连也是可用状态；只有“最后一条就绪后再无任何重连/恢复”才算断链。
  let linked = readyAt >= 0 && (!/DSH 事件流已结束（本次收到 0 帧）/.test(afterReady) || /重连后恢复了进行中的回合|连接 DSH 事件流/.test(afterReady));
  if (!linked) {
    try {
      const ct = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
      const st = await httpJson('http://127.0.0.1:3100/api/status', ct ? { headers: { 'x-console-token': ct } } : {}, 4000);
      linked = st.json?.dshReady === true;
    } catch {}
  }
  add('bridge-dsh-link', linked, linked ? 'DSH 已就绪 (recent)' : 'no recent ready line', { task: 'HerBridge' });
} catch (e) { add('bridge-dsh-link', false, `log unreadable: ${e.message}`, { task: 'HerBridge' }); }

// 6) 其它依赖端口（降级项，不触发重启）：只探 TCP，不假设有 HTTP 根路径
const net = await import('node:net');
const tcpOpen = (port, timeoutMs = 2000) => new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port });
  const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
  sock.setTimeout(timeoutMs);
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
});
for (const [name, port, task] of [['local-llm', 11435, 'HerLocalLLM'], ['sd-server', 11436, 'HerImageServer'], ['xhs-mcp', 18060, 'HerXHS']]) {
  const ok = await tcpOpen(port);
  add(name, ok, ok ? `port ${port} open` : `port ${port} closed`, { required: false, task });
}

const result = { at: new Date().toISOString(), ...summarize(checks) };
try {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
} catch {}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const c of result.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  console.log(result.ok ? '\n健康' : `\n不健康：${result.failed.join(', ')}`);
}
process.exit(result.ok ? 0 : 2);
