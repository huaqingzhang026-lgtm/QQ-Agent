// 受控的「给自己装一个 MCP 工具」入口。
//
// 为什么不让 AI 直接改 cordis.patch.yml：YAML 写坏了 = DSH 起不来 = 她自己也失联；
// 而且加完必须重启 DSH 才生效，重启失败要能回滚。这个脚本把这几步串成一个原子操作。
//
// 用法：
//   node tools\add-mcp.mjs --name demo --script tools\demo-mcp\server.mjs
//   node tools\add-mcp.mjs --name demo --transport http --url http://127.0.0.1:18061/mcp
//   node tools\add-mcp.mjs --remove demo
//   加 --dry 只做检查/打印，不写文件、不重启
//
// 校验：name 合法、脚本存在且能通过 node --check、MCP initialize 握手成功、
//       改完 YAML 仍可解析、重启后 :3080 能起来；任何一步失败自动回滚并重启回旧配置。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
// js-yaml 装在 qq-bridge 里，从那边解析，避免要求工作区根目录也装依赖。
const YAML = createRequire(path.join(ROOT, 'qq-bridge', 'package.json'))('js-yaml');

const PROFILE = path.join(ROOT, 'dsh-home', 'profiles', 'web', 'cordis.patch.yml');
const DSH_LOG = path.join(ROOT, 'dsh-web-3080.log');
const DSH_NODE = process.env.DSH_NODE || process.execPath;
const NODE = fs.existsSync(DSH_NODE) ? DSH_NODE : process.execPath;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const name = arg('name');
const script = arg('script');
const transport = arg('transport', 'stdio');
const url = arg('url');
const timeout = Number(arg('timeout', 120000));
const remove = arg('remove');
const dry = process.argv.includes('--dry');

const log = (m) => console.log(`[add-mcp] ${m}`);
const fail = (m) => { console.error(`[add-mcp] ERROR: ${m}`); process.exit(1); };

// ── 端口 ────────────────────────────────────────────────────────────────────
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
    s.connect(port, host);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidOnPort(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  for (const line of String(r.stdout).split(/\r?\n/)) {
    if (line.includes(`:${port}`) && line.includes('LISTENING')) {
      const parts = line.trim().split(/\s+/);
      return Number(parts[parts.length - 1]);
    }
  }
  return 0;
}

// ── MCP 握手（先证明这个 server 真能说话，再写配置）────────────────────────────
function handshakeStdio(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [scriptPath], { cwd: path.dirname(scriptPath), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, '15 秒内没有 initialize 响应'), 15000);
    child.stdout.on('data', (d) => {
      buf += String(d);
      for (const line of buf.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 1 && m.result) { clearTimeout(timer); finish(true, m.result?.serverInfo?.name ?? 'ok'); }
        } catch { /* 还没拼完一行 */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); finish(false, e.message); });
    child.on('exit', (code) => { if (!done) { clearTimeout(timer); finish(false, `进程退出 code=${code}`); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'add-mcp', version: '1' } } }) + '\n');
  });
}

async function handshakeHttp(target) {
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'add-mcp', version: '1' } } }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const body = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse((text.split('\n').find((l) => l.startsWith('data:')) ?? 'data:{}').slice(5));
    return body?.result ? { ok: true, detail: body.result?.serverInfo?.name ?? 'ok' } : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// ── 配置文本操作（按块删除，保留人工注释）──────────────────────────────────────
const START = '# === added-by-add-mcp ===';

function blockFor(id, serverName) {
  const lines = [
    START,
    `# ${id}：由 tools/add-mcp.mjs 生成；用 --remove ${serverName} 卸载。`,
  ];
  if (transport === 'stdio') {
    lines.push(
      '- insert:',
      `    - id: ${id}`,
      `      name: '@deepseek-ai/dsh-mcp-client'`,
      '      config:',
      `        serverName: ${serverName}`,
      '        transport: stdio',
      `        command: '${NODE.replace(/\\/g, '\\\\')}'`,
      '        args:',
      `          - '${script.replace(/\\/g, '\\\\')}'`,
      `        toolCallTimeoutMs: ${timeout}`,
    );
  } else {
    lines.push(
      '- insert:',
      `    - id: ${id}`,
      `      name: '@deepseek-ai/dsh-mcp-client'`,
      '      config:',
      `        serverName: ${serverName}`,
      '        transport: streamable-http',
      `        url: '${url}'`,
      `        toolCallTimeoutMs: ${timeout}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function stripBlock(text, serverName) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!skipping && line.includes(`- id: mcp-${serverName}`)) {
      // 往回找这一段开头（我们的标记或 - insert:）
      let start = out.length - 1;
      while (start >= 0 && !out[start].includes('added-by-add-mcp') && !/^-\s*insert:\s*$/.test(out[start])) start--;
      if (start >= 0) {
        // 若是 insert 行且上一行是注释，也一起收回
        if (out[start].includes('added-by-add-mcp') || /^# === added-by/.test(out[start])) { /* keep */ }
        out.length = start;
      }
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s*$/.test(line) || /^\s/.test(line) || /^#/.test(line)) continue;
      skipping = false;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── DSH 重启 ───────────────────────────────────────────────────────────────
async function restartDsh() {
  const pid = pidOnPort(3080);
  if (pid) { spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }); log(`已停掉 :3080 (pid ${pid})`); }
  for (let i = 0; i < 20 && await portOpen(3080); i++) await sleep(500);
  spawnSync('schtasks', ['/Run', '/TN', 'HerDSH'], { windowsHide: true });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (await portOpen(3080)) return true;
  }
  return false;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
if (!name && !remove) fail('用法：--name <工具名> --script <server.mjs> | --transport http --url <url> | --remove <工具名>');

const serverName = String(remove ?? name).trim();
if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) fail(`名字不合法：${serverName}（只允许字母数字 _ -，最长 32）`);
const id = `mcp-${serverName}`;

if (!fs.existsSync(PROFILE)) fail(`找不到 profile 配置：${PROFILE}`);
let original = fs.readFileSync(PROFILE, 'utf8');

if (remove) {
  if (!original.includes(`- id: ${id}`)) fail(`配置里没有 ${id}，无需删除`);
  const next = stripBlock(original, serverName);
  if (dry) { log('[dry] 将删除的配置片段：'); console.log(next.slice(Math.max(0, next.indexOf(START) - 200))); process.exit(0); }
  fs.writeFileSync(`${PROFILE}.bak-${Date.now()}`, original, 'utf8');
  fs.writeFileSync(PROFILE, next, 'utf8');
  try { YAML.load(next); } catch (e) { fs.writeFileSync(PROFILE, original, 'utf8'); fail(`删除后 YAML 解析失败，已回滚：${e.message}`); }
  log(`已从配置里移除 ${id}`);
  log('重启 DSH …');
  if (!await restartDsh()) fail('重启后 :3080 没起来，请检查 dsh-web-3080.log');
  log('完成。');
  process.exit(0);
}

// 加：先校验
let serverScript = null;
if (transport === 'stdio') {
  serverScript = path.resolve(ROOT, String(script ?? ''));
  if (!script) fail('stdio 需要 --script <server.mjs>');
  if (!fs.existsSync(serverScript)) fail(`脚本不存在：${serverScript}`);
  const check = spawnSync(NODE, ['--check', serverScript], { encoding: 'utf8', windowsHide: true });
  if (check.status !== 0) fail(`语法检查失败：${(check.stderr || check.stdout || '').slice(0, 400)}`);
  log(`脚本语法 OK：${path.relative(ROOT, serverScript)}；握手测试中 …`);
  const hs = await handshakeStdio(serverScript);
  if (!hs.ok) fail(`MCP 握手失败：${hs.detail}`);
  log(`握手成功（serverInfo=${hs.detail}）`);
} else if (transport === 'http') {
  if (!url) fail('http 需要 --url <http://.../mcp>');
  log(`HTTP 握手测试：${url}`);
  const hs = await handshakeHttp(String(url));
  if (!hs.ok) fail(`MCP HTTP 握手失败：${hs.detail}`);
  log(`握手成功（serverInfo=${hs.detail}）`);
} else {
  fail(`未知 transport：${transport}`);
}

if (original.includes(`- id: ${id}`)) fail(`配置里已经有 ${id}，先 --remove 或换个名字`);

const next = `${original.replace(/\s*$/, '')}\n\n${blockFor(id, serverName)}`;
try { YAML.load(next); } catch (e) { fail(`新配置 YAML 解析失败，未写入：${e.message}`); }

if (dry) { log('[dry] 配置片段：'); console.log(blockFor(id, serverName)); process.exit(0); }

const bak = `${PROFILE}.bak-${Date.now()}`;
fs.writeFileSync(bak, original, 'utf8');
fs.writeFileSync(PROFILE, next, 'utf8');
log(`已写入 ${id}（备份：${path.basename(bak)}）`);

log('重启 DSH …');
const up = await restartDsh();
const logText = fs.existsSync(DSH_LOG) ? fs.readFileSync(DSH_LOG, 'utf8') : '';
const bad = !up || new RegExp(`${serverName}[^\\n]*(error|failed|失败)`, 'i').test(logText);
if (bad) {
  fs.writeFileSync(PROFILE, original, 'utf8');
  log('⚠️ 重启后异常，已回滚配置并再重启一次 …');
  await restartDsh();
  fail('安装失败，配置已回滚');
}

const tokenLine = logText.split(/\r?\n/).filter((l) => l.includes('dsh web: http')).pop();
log('安装成功。');
if (tokenLine) log(tokenLine.trim());
