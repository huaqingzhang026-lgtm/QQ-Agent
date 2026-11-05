const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
// A03-rework2 R02：真实 image-mcp 工具 schema/参数转发 + v2 图片路由缺凭证拒绝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const candidate = CANDIDATE_ROOT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a03-r02-'));
const results = [];
function test(id, fn) { try { const p = fn(); if (p && typeof p.then === 'function') return p.then((detail) => results.push({ id, ok: true, detail }), (e) => results.push({ id, ok: false, error: String(e?.stack ?? e) })); results.push({ id, ok: true, detail: p }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

// --- 真实 image-mcp 服务器（复制到临时 ROOT，不碰 candidate state） ---
const mcpRoot = path.join(root, 'image-root');
fs.mkdirSync(path.join(mcpRoot, 'image-mcp'), { recursive: true });
fs.mkdirSync(path.join(mcpRoot, 'qq-bridge', 'state'), { recursive: true });
fs.mkdirSync(path.join(mcpRoot, 'agent-home', 'notes', 'images'), { recursive: true });
fs.copyFileSync(path.join(candidate, 'image-mcp', 'server.mjs'), path.join(mcpRoot, 'image-mcp', 'server.mjs'));
fs.writeFileSync(path.join(mcpRoot, 'qq-bridge', 'state', 'console-token'), 'synthetic-console-token\n');
fs.writeFileSync(path.join(mcpRoot, 'qq-bridge', 'config.json'), JSON.stringify({ allow: { private: ['1'], groups: [] } }));
const imageFile = path.join(mcpRoot, 'agent-home', 'notes', 'images', 'synthetic.png');
fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const received = [];
let bridgeServer;
const bridgePort = await new Promise((resolve) => {
  bridgeServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageId: 'synthetic-message' }));
    });
  });
  bridgeServer.listen(0, '127.0.0.1', () => resolve(bridgeServer.address().port));
});
const mcp = spawn(process.execPath, [path.join(mcpRoot, 'image-mcp', 'server.mjs')], {
  env: { ...process.env, HER_BRIDGE_URL: `http://127.0.0.1:${bridgePort}` },
  stdio: ['pipe', 'pipe', 'ignore'],
});
let buf = '';
const waiters = new Map();
mcp.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    try { const msg = JSON.parse(line); const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } } catch {}
  }
});
function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mcp timeout ' + method)), 8000);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
const listed = await rpc(2, 'tools/list', {});
const sendTool = listed.result.tools.find((t) => t.name === 'send_image');
await test('schema-requires-executionId', () => {
  assert.ok(sendTool);
  assert.deepEqual(sendTool.inputSchema.required, ['file', 'key', 'executionId']);
  return sendTool.inputSchema.required;
});
const missing = await rpc(3, 'tools/call', { name: 'send_image', arguments: { file: imageFile, key: 'private:1' } });
await test('missing-executionId-no-bridge', () => {
  const text = String(missing.result?.content?.[0]?.text ?? '');
  assert.equal(missing.result?.isError, true);
  assert.match(text, /executionId/);
  assert.equal(received.length, 0);
  return { received: received.length, text: text.slice(0, 120) };
});
const forward = await rpc(4, 'tools/call', { name: 'send_image', arguments: { file: imageFile, key: 'private:1', executionId: 'exec-r02-test' } });
await test('forward-executionId-to-bridge', () => {
  assert.equal(forward.result?.isError, undefined);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.executionId, 'exec-r02-test');
  assert.equal(received[0].headers['x-agent-call'], '1');
  assert.equal(received[0].headers['x-console-token'], 'synthetic-console-token');
  return { received: received.length, body: received[0].body, agentCall: received[0].headers['x-agent-call'] };
});
mcp.kill();
bridgeServer.close();

// --- v2 图片路由：缺/空/错/旧/跨 scope 凭证均 0 传输；合法 1 次 ---
const { source, makeWorld, seedDecision } = await import('./bridge-fixture.mjs');
const vm = await import('node:vm');
const pathMod = await import('node:path');

function routeWith({ credential, start = "if (req.method === 'POST' && url.pathname === '/api/images/send')", transform, finalMutate }) {
  const w = makeWorld();
  const { execution } = seedDecision(w);
  const oldExecutionId = execution.executionId;
  let calls = 0, guards = 0;
  const guard = w.ctx.decisionSendGuard;
  w.ctx.decisionSendGuard = (...args) => { guards++; return guard(...args); };
  const execId = credential === 'valid' ? execution.executionId
    : credential === 'old' ? (() => { seedDecision(w); return oldExecutionId; })()
    : credential === 'cross' ? (() => { const now = Date.now(); const decision = w.ctx.buildDecision({ key: 'private:2', snapshot: w.getSnapshot(), text: 'x', now }); const ex = w.ctx.createExecutionContext({ key: 'private:2', decision, sessionId: 'sess-1', epoch: w.st.decisionEpoch, seq: 7, now }); w.st.activeDecision = decision; w.st.activeExecution = ex; w.st.activeExecutionId = ex.executionId; w.ctx.executionContexts.set(ex.executionId, ex); return ex.executionId; })()
    : credential === 'missing' ? undefined : '';
  const body = { key: 'private:1', file: 'C:/synthetic/image-mcp/probe.png' };
  if (execId !== undefined) body.executionId = execId;
  if (transform) transform(body, w);
  Object.assign(w.ctx, {
    req: { method: 'POST' }, url: { pathname: '/api/images/send' }, ROOT: 'C:/synthetic/qq-bridge', path: pathMod, fs: { statSync: () => ({ isFile: () => true, size: 100 }) },
    readBody: async () => body, modeAllowed: () => true, isSilentConversationV2: () => false, personalityEnabled: () => true,
    quotaState: () => ({ full: false }), capForConversation: () => 10, sendJson: (b, status = 200) => { w.responses = w.responses || []; w.responses.push({ b, status }); },
    postOneBot: async () => { calls++; return { body: { data: { message_id: 123 } } }; },
    outboundGateway: { submit: async (input) => ({ state: 'sent', result: await input.send() }) },
  });
  if (finalMutate) w.ctx.outboundGateway.submit = async (input) => { finalMutate(w); try { return { state: 'sent', result: await input.send() }; } catch (error) { return { state: 'failed', detail: error?.message ?? String(error) }; } };
  const startIdx = source.indexOf(start); const end = source.indexOf('\n        if (', startIdx + 5);
  vm.runInContext('(async()=>{' + source.slice(startIdx, end) + '\n})()', w.ctx);
  return { getCalls: () => calls, getGuards: () => guards, w, execution, execId, active: w.st.activeExecutionId };
}

await test('route-final-invalidation-zero', () => {
  const r = routeWith({ credential: 'valid', finalMutate: (w) => { w.st.activeExecutionId = 'replaced-before-final'; } });
  return new Promise((resolve) => setImmediate(() => { assert.equal(r.getCalls(), 0); resolve({ calls: r.getCalls(), responses: r.w.responses }); }));
});
await test('route-valid-one', () => { const r = routeWith({ credential: 'valid' }); return new Promise((resolve) => setImmediate(() => {  assert.equal(r.getCalls(), 1); resolve({ calls: r.getCalls() }); })); });
for (const kind of ['missing', 'empty', 'old', 'cross']) {
  await test('route-' + kind + '-zero', () => { const r = routeWith({ credential: kind }); return new Promise((resolve) => setImmediate(() => { assert.equal(r.getCalls(), 0, kind + ' exec=' + String(r.execId).slice(0,8) + ' active=' + String(r.active).slice(0,8) + ' guards=' + r.getGuards() + ' responses=' + JSON.stringify(r.w.responses)); resolve({ calls: r.getCalls(), guards: r.getGuards() }); })); });
}
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(process.env.A00_DATA_ROOT || root, 'a03-r02-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
process.exit(out.summary.failed ? 1 : 0);

