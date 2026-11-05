// agent-ops MCP：主人私聊专用的受控施工工具。
//
// 安全边界：
//   · 只接受 private:<ownerQQ> 的 agent token；
//   · 只允许白名单路径；
//   · 所有写入先备份；
//   · JS 语法检查 + acceptance 失败自动回滚；
//   · 补丁需要主人把 6 位确认码发回来才能应用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { applyEvolution, evolutionStatus, pauseEvolution, rollback } from './persona-evolution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const OPS_DIR = path.join(STATE, 'agent-ops');
const PENDING_DIR = path.join(OPS_DIR, 'pending');
const OWNER_CONSENT_FILE = path.join(STATE, 'owner-consent.json');
const SELF_FIX_FILE = path.join(STATE, 'self-fix-grant.json');
const BRIDGE = 'http://127.0.0.1:3100';

const ALLOW = [
  'agent-home/notes/',
  'agent-home/persona/',
  'agent-home/skills/',
  'qq-bridge/src/',
  'qq-bridge/config.json',
  'qq-bridge/dsh/agent-presets/qq-chat-v2/',
  'tools/',
];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const log = (m) => { try { fs.appendFileSync(path.join(STATE, 'agent-ops.log'), `[${new Date().toISOString()}] ${m}\n`); } catch {} };

function selfFixActive() {
  try { const c = JSON.parse(fs.readFileSync(SELF_FIX_FILE, 'utf8')); return Number(c?.until) > Date.now(); } catch { return false; }
}

function ownerConsentActive() {
  try { const c = JSON.parse(fs.readFileSync(OWNER_CONSENT_FILE, 'utf8')); return Number(c?.until) > Date.now(); } catch { return false; }
}

function relPath(p) {
  const abs = path.resolve(ROOT, String(p || ''));
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界');
  if (!ALLOW.some((a) => rel === a || rel.startsWith(a))) throw new Error('路径不在白名单内：' + rel);
  return { abs, rel };
}

async function verify(key, token) {
  if (!key || !token) return { ok: false, owner: false };
  try {
    const r = await fetch(BRIDGE + '/api/agent/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, token }) });
    return await r.json();
  } catch { return { ok: false, owner: false }; }
}

async function requireOwner(key, token) {
  const v = await verify(key, token);
  if (!v.ok || !v.owner) throw new Error('仅主人私聊可用（agent token 校验失败或会话不是 private:owner）');
  return v;
}

function notifyOwner(text) {
  try {
    const consoleToken = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
    return fetch(BRIDGE + '/api/outbound/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ key: 'private:' + String(JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8')).ownerQQ || ''), text: String(text).slice(0, 800), exempt: true, record: true }),
    }).catch(() => {});
  } catch { return Promise.resolve(); }
}

function runNode(args, timeout = 120000) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) };
}

function checkSyntax(abs) {
  if (!/\.(mjs|js)$/.test(abs)) return { ok: true, out: '' };
  const r = runNode(['--check', abs], 20000);
  return { ok: r.code === 0, out: r.out };
}

function backup(abs, rel) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, 'backups', 'agent-ops', stamp);
  const dest = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(abs)) fs.copyFileSync(abs, dest);
  return { dir, dest };
}

function diffPreview(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < 80; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push('- ' + a[i]);
    if (b[i] !== undefined) out.push('+ ' + b[i]);
  }
  return out.join('\n').slice(0, 3000) || '（内容无变化）';
}

const server = new McpServer({ name: 'agent-ops', version: '1.0.0' });

server.tool('ops_persona_apply', '应用一小段人格演化 overlay；score<8 拒绝，自动备份/版本/限额', {
  key: z.string(), token: z.string(), section: z.string().max(30), content: z.string().max(2000), reason: z.string().max(300), score: z.number().min(0).max(100),
}, async ({ key, token, section, content, reason, score }) => {
  try {
    await requireOwner(key, token);
    if (Number(score) < 8) throw new Error('证据分不足 8，不能应用');
    const r = applyEvolution({ section, content, reason, score, source: 'self' });
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_persona_status', '查看人格演化层版本/证据分/变更数（主人私聊专用）', {
  key: z.string(), token: z.string(),
}, async ({ key, token }) => {
  try { await requireOwner(key, token); return { content: [{ type: 'text', text: JSON.stringify(evolutionStatus(), null, 2) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_persona_rollback', '回滚人格演化层到指定版本（主人私聊专用）', {
  key: z.string(), token: z.string(), version: z.number().int().min(0).optional(),
}, async ({ key, token, version }) => {
  try { await requireOwner(key, token); const r = rollback(version); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_status', '查看桥接/DSH/日志状态（主人私聊专用）', {
  key: z.string(), token: z.string(),
}, async ({ key, token }) => {
  try {
    await requireOwner(key, token);
    const logs = ['bridge.log', 'agent-ops.log'].map((n) => {
      const f = path.join(STATE, n);
      return n + ': ' + (fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) + ' KB' : '不存在');
    });
    const pids = ['browse.pid', 'live-roam.pid', 'live-danmaku.pid'].map((n) => {
      const f = path.join(STATE, n);
      return n + ': ' + (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '无');
    });
    return { content: [{ type: 'text', text: JSON.stringify({ logs, pids, allow: ALLOW }, null, 2) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_read_log', '读取允许的日志尾部（主人私聊专用）', {
  key: z.string(), token: z.string(), name: z.enum(['bridge.log', 'bridge.log.1', 'agent-ops.log', 'browse.log', 'live-roam.log']), lines: z.number().int().min(1).max(200).optional(),
}, async ({ key, token, name, lines }) => {
  try {
    await requireOwner(key, token);
    const f = path.join(STATE, name);
    if (!fs.existsSync(f)) throw new Error('日志不存在');
    const arr = fs.readFileSync(f, 'utf8').split('\n');
    return { content: [{ type: 'text', text: arr.slice(-(lines || 60)).join('\n').slice(-12000) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_run_acceptance', '跑一次 acceptance 验收（主人私聊专用）', {
  key: z.string(), token: z.string(),
}, async ({ key, token }) => {
  try {
    await requireOwner(key, token);
    const r = runNode(['tools/acceptance.mjs', '--allow-degraded'], 180000);
    return { content: [{ type: 'text', text: `exit=${r.code}\n${r.out}` }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_write_note', '写笔记/技能文档（仅 agent-home/notes、agent-home/skills）', {
  key: z.string(), token: z.string(), path: z.string(), content: z.string().max(200000),
}, async ({ key, token, path: p, content }) => {
  try {
    await requireOwner(key, token);
    const { abs, rel } = relPath(p);
    if (!(rel.startsWith('agent-home/notes/') || rel.startsWith('agent-home/skills/'))) throw new Error('只允许写 notes/skills');
    backup(abs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    log(`write_note ${rel}`);
    return { content: [{ type: 'text', text: '已写入 ' + rel }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_create_skill', '把聊天里学到的东西写成技能笔记（SKILL.md）', {
  key: z.string(), token: z.string(), name: z.string().min(1).max(40), summary: z.string(), steps: z.array(z.string()).max(20),
}, async ({ key, token, name, summary, steps }) => {
  try {
    await requireOwner(key, token);
    const safe = String(name).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40);
    const rel = `agent-home/skills/${safe}/SKILL.md`;
    const content = `# ${name}\n\n${summary}\n\n## 步骤\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
    const { abs } = relPath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    log(`create_skill ${rel}`);
    return { content: [{ type: 'text', text: '技能已写入 ' + rel }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_propose_patch', '提出文件补丁（不落盘），确认码会发到主人 QQ', {
  key: z.string(), token: z.string(), path: z.string(), content: z.string().max(300000), reason: z.string().max(300),
}, async ({ key, token, path: p, content, reason }) => {
  try {
    await requireOwner(key, token);
    const { abs, rel } = relPath(p);
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const id = 'p' + Date.now().toString(36);
    writeJson(path.join(PENDING_DIR, id + '.json'), { id, code, abs, rel, content, old, reason, at: Date.now() });
    await notifyOwner(`【施工确认】${rel}\n原因：${reason}\n确认码：${code}\n把确认码发给我才会应用；不回复则作废。`);
    log(`propose ${id} ${rel}`);
    return { content: [{ type: 'text', text: `已生成补丁 ${id}（${rel}），确认码已发到主人 QQ。\n\n变更预览：\n${diffPreview(old, content)}` }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_apply_patch', '应用补丁；主人明确同意后可不填确认码，否则仍用 6 位确认码（自动备份/验收/回滚）', {
  key: z.string(), token: z.string(), id: z.string(), code: z.string().optional(),
}, async ({ key, token, id, code }) => {
  try {
    await requireOwner(key, token);
    const f = path.join(PENDING_DIR, id + '.json');
    const item = readJson(f, null);
    if (!item) throw new Error('补丁不存在或已过期');
    const consent = ownerConsentActive();
    if (code && String(item.code) !== String(code)) throw new Error('确认码不正确');
    const selfFix = selfFixActive();
    if (!code && !consent && !selfFix) throw new Error('需要确认码，或主人先在私聊里明确同意施工，或开启自动修复');
    const { abs, rel } = relPath(item.rel);
    const { dir } = backup(abs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, item.content, 'utf8');
    const syn = checkSyntax(abs);
    if (!syn.ok) {
      if (fs.existsSync(path.join(dir, rel))) fs.copyFileSync(path.join(dir, rel), abs);
      return { isError: true, content: [{ type: 'text', text: `语法检查失败，已回滚：\n${syn.out}` }] };
    }
    const acc = runNode(['tools/acceptance.mjs', '--allow-degraded'], 180000);
    if (acc.code !== 0) {
      if (fs.existsSync(path.join(dir, rel))) fs.copyFileSync(path.join(dir, rel), abs);
      const pause = pauseEvolution(24, 'acceptance failed: ' + String(acc.out || '').slice(0, 160));
      return { isError: true, content: [{ type: 'text', text: `验收失败，已回滚（备份 ${dir}）；人格自改暂停 ${pause.hours}h：\n${acc.out}` }] };
    }
    fs.unlinkSync(f);
    log(`apply ${id} ${rel}${code ? ' code' : consent ? ' owner-consent' : ' self-fix'}`);
    return { content: [{ type: 'text', text: `已应用 ${rel}；备份：${dir}\n验收：exit=0` }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_restart_service', '重启桥接或 DSH（主人私聊专用）', {
  key: z.string(), token: z.string(), service: z.enum(['bridge', 'dsh']),
}, async ({ key, token, service }) => {
  try {
    await requireOwner(key, token);
    const task = service === 'dsh' ? 'HerDSH' : 'HerBridge';
    const r = spawnSync('schtasks.exe', ['/End', '/TN', task], { encoding: 'utf8', windowsHide: true });
    spawnSync('schtasks.exe', ['/Run', '/TN', task], { encoding: 'utf8', windowsHide: true });
    log(`restart ${task}`);
    return { content: [{ type: 'text', text: `已重启 ${task}（End exit=${r.status}）` }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});


const DSH_RUNTIME = process.env.DSH_RUNTIME || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime');
const PNPM = process.env.PNPM_CLI || path.join(DSH_RUNTIME, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
const DSH = process.env.DSH_CLI || path.join(DSH_RUNTIME, 'cli', 'bin', 'dsh.cmd');
const PKG_RE = /^(@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*$/;

server.tool('ops_propose_package_install', '提议安装 npm 包/DSH 插件（确认码发主人 QQ）', {
  key: z.string(), token: z.string(),
  target: z.enum(['qq-bridge', 'dsh-profile']),
  package: z.string().min(1).max(150),
  reason: z.string().max(300),
  profilePatchAppend: z.string().max(5000).optional(),
}, async ({ key, token, target, package: pkg, reason, profilePatchAppend }) => {
  try {
    await requireOwner(key, token);
    if (!PKG_RE.test(pkg)) throw new Error('包名不合法');
    if (target === 'qq-bridge' && profilePatchAppend) throw new Error('qq-bridge 目标不需要 profilePatchAppend');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const id = 'k' + Date.now().toString(36);
    writeJson(path.join(PENDING_DIR, id + '.json'), { id, code, target, package: pkg, reason, profilePatchAppend: profilePatchAppend || '', at: Date.now() });
    await notifyOwner('【安装确认】' + target + ' ← ' + pkg + '\n原因：' + reason + '\n确认码：' + code + '\n把确认码发给我才会安装。');
    log('propose_install ' + id + ' ' + target + ' ' + pkg);
    return { content: [{ type: 'text', text: '已生成安装提议 ' + id + '（' + target + ' ← ' + pkg + '），确认码已发到主人 QQ。' }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('ops_apply_package_install', '安装包/插件；主人明确同意后可不填确认码（备份+失败回滚）', {
  key: z.string(), token: z.string(), id: z.string(), code: z.string().optional(),
}, async ({ key, token, id, code }) => {
  try {
    await requireOwner(key, token);
    const f = path.join(PENDING_DIR, id + '.json');
    const item = readJson(f, null);
    if (!item) throw new Error('安装提议不存在或已过期');
    const consent = ownerConsentActive();
    if (code && String(item.code) !== String(code)) throw new Error('确认码不正确');
    if (!code && !consent) throw new Error('需要确认码，或主人先在私聊里明确同意施工');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(ROOT, 'backups', 'agent-ops', stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    let cwd;
    let cmd;
    let args;
    const files = [];
    if (item.target === 'dsh-profile') {
      cwd = path.join(ROOT, 'dsh-home', 'profiles', 'web');
      files.push('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml');
      for (const name of files) { const src = path.join(cwd, name); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, name)); }
      cmd = DSH;
      args = ['plugin', '--profile', 'web', 'add', item.package];
    } else {
      cwd = path.join(ROOT, 'qq-bridge');
      files.push('package.json', 'pnpm-lock.yaml');
      for (const name of files) { const src = path.join(cwd, name); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, name)); }
      cmd = process.execPath;
      args = [PNPM, 'add', item.package];
    }
    const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000, windowsHide: true });
    const out = ((run.stdout || '') + (run.stderr || '')).slice(-4000);
    if (run.status !== 0) {
      for (const name of files) { const bak = path.join(backupDir, name); if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(cwd, name)); }
      log('install failed ' + item.package + ': ' + out.slice(0, 300));
      return { isError: true, content: [{ type: 'text', text: '安装失败，已恢复备份。\n' + out }] };
    }
    if (item.target === 'dsh-profile' && item.profilePatchAppend) {
      const patchFile = path.join(cwd, 'cordis.patch.yml');
      const oldPatch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
      fs.writeFileSync(patchFile, oldPatch + '\n' + item.profilePatchAppend + '\n', 'utf8');
      fs.copyFileSync(patchFile, path.join(backupDir, 'cordis.patch.yml.after'));
    }
    fs.unlinkSync(f);
    log('install ok ' + item.package + (code ? ' code' : ' owner-consent'));
    return { content: [{ type: 'text', text: '已安装 ' + item.package + '（' + item.target + '）。备份：' + backupDir + (item.target === 'dsh-profile' ? '\n需要重启 DSH 才能加载插件，可调用 ops_restart_service(service="dsh")。' : '') }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

await server.connect(new StdioServerTransport());
