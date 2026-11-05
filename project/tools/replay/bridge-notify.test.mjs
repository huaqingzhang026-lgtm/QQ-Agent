// 回放：脚本 → 桥接通知的失败分支（F02/F03）。
// 用假桥接注入 403/429/502/坏 JSON/超时，确认 helper 一律 ok:false 且不回退直连。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { notifyViaBridge } from '../../tools/lib/bridge-notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

// 假桥接
let mode = 'ok';
const server = http.createServer((req, res) => {
  if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, messageId: 'm1' })); return; }
  if (mode === '403') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '该会话处于静默期' })); return; }
  if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '额度用完' })); return; }
  if (mode === '502') { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'send-failed' })); return; }
  if (mode === 'badjson') { res.writeHead(200); res.end('not json'); return; }
  if (mode === 'hang') { return; } // 不响应，触发超时
  res.writeHead(500); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.HER_BRIDGE_URL = `http://127.0.0.1:${port}`;
process.env.HER_CONSOLE_TOKEN_FILE = path.join(os.tmpdir(), `tok-${process.pid}`);
fs.writeFileSync(process.env.HER_CONSOLE_TOKEN_FILE, 'test-token\n');

const call = (opts = {}) => notifyViaBridge({ key: 'group:1', text: 'hi', ...opts });

await check('桥接 ok → ok:true', async () => {
  mode = 'ok';
  const r = await call();
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'm1');
});

for (const [m, label] of [['403', '静默期'], ['429', '额度'], ['502', '发送失败']]) {
  await check(`桥接 ${m} → ok:false（${label}）`, async () => {
    mode = m;
    const r = await call();
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0);
    assert.equal(r.status, Number(m));
  });
}

await check('坏 JSON 不崩，按失败处理', async () => {
  mode = 'badjson';
  const r = await call();
  assert.equal(r.ok, false);
});

await check('超时 → ok:false', async () => {
  mode = 'hang';
  const r = await call({ timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /abort|timeout/i);
});

await check('桥接地址不可达 → ok:false', async () => {
  process.env.HER_BRIDGE_URL = 'http://127.0.0.1:1';
  const r = await notifyViaBridge({ key: 'group:1', text: 'hi' });
  assert.equal(r.ok, false);
  process.env.HER_BRIDGE_URL = `http://127.0.0.1:${port}`;
});

// 静态约束：脚本/图片服务里不允许再出现直连 OneBot 的调用
const sources = [
  path.join(ROOT, 'tools', 'live-watch.mjs'),
  path.join(ROOT, 'tools', 'dormant-nudge.mjs'),
  path.join(ROOT, 'image-mcp', 'server.mjs'),
  path.join(ROOT, 'tools', 'daily-report.mjs'),
  path.join(ROOT, 'tools', 'subscribe-check.mjs'),
];
for (const f of sources) {
  await check(`无直连 OneBot：${path.basename(f)}`, async () => {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/send_group_msg|send_private_msg/.test(src), `仍包含直连调用：${path.basename(f)}`);
  });
}

server.close();
console.log(`bridge-notify replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
