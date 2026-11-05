// 集成回放：真实 memory-mcp 的会话隔离（F01）。
//
// 不碰生产：用 MEMORY_MCP_ROOT / MEMORY_SCOPE_SECRET_FILE 指向临时目录，
// 目录里塞合成私聊/群聊/公共笔记，启动真实 server 走 stdio JSON-RPC。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ensureSecret, mintScopeToken } from '../../qq-bridge/src/memory-scope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-iso-'));

// 合成数据
fs.mkdirSync(path.join(tmp, 'agent-home', 'notes'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'agent-home', 'notes', 'shared.md'), '公共笔记：西瓜很甜\n', 'utf8');
fs.mkdirSync(path.join(tmp, 'agent-home', 'notes', 'daily'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'agent-home', 'notes', 'daily', '2026-10-23.md'), '日记：今天主人说了一个秘密暗号\n', 'utf8');
fs.mkdirSync(path.join(tmp, 'qq-bridge', 'state'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'qq-bridge', 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'qq-bridge', 'src', 'memory-scope.js'), path.join(tmp, 'qq-bridge', 'src', 'memory-scope.js'));
fs.writeFileSync(path.join(tmp, 'qq-bridge', 'config.json'), JSON.stringify({ ownerQQ: '10001' }), 'utf8');
fs.writeFileSync(path.join(tmp, 'qq-bridge', 'state', 'social-v2.json'), JSON.stringify({
  conversations: {
    'private:10001': { recentMessages: [{ sender: '主人', text: '私聊秘密西瓜', time: Date.now() }] },
    'group:20002': { recentMessages: [{ sender: '群友', text: '群里的西瓜话题', time: Date.now() }] },
  },
}, null, 2), 'utf8');

const secretFile = path.join(tmp, 'secret.key');
const secret = ensureSecret(secretFile);
const privateToken = mintScopeToken(secret, 'private:10001');
const groupToken = mintScopeToken(secret, 'group:20002');

const child = spawn(NODE, [path.join(ROOT, 'memory-mcp', 'server.mjs')], {
  env: { ...process.env, MEMORY_MCP_ROOT: tmp, MEMORY_SCOPE_SECRET_FILE: secretFile },
  stdio: ['pipe', 'pipe', 'ignore'],
});
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let idSeq = 0;
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++idSeq;
  pending.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 15000);
});
const resultText = (r) => (Array.isArray(r?.results) ? r.results.map((x) => x.text ?? '').join('\n') : '');
const search = async (query, scopeToken) => {
  const r = await call('tools/call', { name: 'memory_search', arguments: { query, ...(scopeToken ? { scopeToken } : {}) } });
  const text = (r?.result?.content ?? []).map((c) => c.text ?? '').join(' ');
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

await check('无令牌：查不到私聊秘密', async () => {
  const r = await search('私聊秘密');
  const text = JSON.stringify(r);
  assert.ok(!resultText(r).includes('私聊秘密'), `泄露了：${text.slice(0, 200)}`);
});

await check('无令牌：公共笔记可见', async () => {
  const r = await search('西瓜很甜');
  assert.ok(resultText(r).includes('公共笔记'), '公共笔记应可检索');
});

await check('私聊令牌：能查私聊秘密', async () => {
  const r = await search('私聊秘密', privateToken);
  assert.ok(resultText(r).includes('私聊秘密'));
});

await check('私聊令牌：查不到群聊记录', async () => {
  const r = await search('群里的西瓜', privateToken);
  assert.ok(!resultText(r).includes('群里的西瓜'));
});

await check('群令牌：查不到私聊秘密', async () => {
  const r = await search('私聊秘密', groupToken);
  assert.ok(!resultText(r).includes('私聊秘密'));
});

await check('群令牌：能查本群记录', async () => {
  const r = await search('群里的西瓜', groupToken);
  assert.ok(resultText(r).includes('群里的西瓜'));
});

await check('伪造令牌：按无令牌处理', async () => {
  const r = await search('私聊秘密', 'forged.token.value');
  assert.ok(!resultText(r).includes('私聊秘密'));
});

await check('群令牌：读不到日记（私有笔记）', async () => {
  const r = await search('秘密暗号', groupToken);
  assert.ok(!resultText(r).includes('秘密暗号'));
});

await check('私聊令牌：能读日记', async () => {
  const r = await search('秘密暗号', privateToken);
  assert.ok(resultText(r).includes('秘密暗号'));
});

child.kill();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`memory-isolation: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过（真实 server，未触生产）');
