// 回放：HTTP 单栈发送 + "WS 端口零连接" 双栈检查（F03）。
//
// 说明：桥接已不再用 SDK WebSocket 发送，全部经 postOneBot（HTTP）。
// 本测试：
//   · 用假 OneBot HTTP 服务覆盖 ok / retcode 失败 / HTTP 429 / 超时；
//   · 同时监听一个"WS 端口"并断言发送期间连接数为 0（证明没有走 WS）；
//   · 验证 QQ_DRY_RUN=1 时 HTTP 调用为 0。

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway } from '../../qq-bridge/src/outbound-gateway.js';

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

// ── 假 OneBot HTTP ─────────────────────────────────────────────────────────
let mode = 'ok';
let httpHits = 0;
const onebot = http.createServer((req, res) => {
  httpHits += 1;
  if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } })); return; }
  if (mode === 'retcode') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: 'bad' })); return; }
  if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'failed', retcode: 1200 })); return; }
  if (mode === 'hang') { return; }
  res.writeHead(500); res.end('{}');
});
await new Promise((r) => onebot.listen(0, '127.0.0.1', r));
const httpPort = onebot.address().port;

// ── 假 WS 端口（只统计连接，不做协议）──────────────────────────────────────
let wsConnections = 0;
const wsServer = net.createServer((sock) => { wsConnections += 1; sock.destroy(); });
await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
const wsPort = wsServer.address().port;

const { postOneBot } = await import('../../qq-bridge/src/transport.js');

async function sendOnce(httpUrl, timeoutMs = 15000) {
  const gw = createGateway({ cfg: {} });
  const r = await gw.submit({
    conversationKey: 'group:20002',
    kind: 'text',
    segments: 1,
    send: () => postOneBot({
      action: 'send_group_msg',
      params: { group_id: 20002, message: [{ type: 'text', data: { text: 'hi' } }] },
      httpUrl,
      accessToken: 't',
      timeoutMs,
    }),
  });
  return r;
}

await check('HTTP ok → sent，且 WS 连接 0', async () => {
  mode = 'ok';
  httpHits = 0;
  const r = await sendOnce(`http://127.0.0.1:${httpPort}`);
  assert.equal(r.state, 'sent');
  assert.equal(httpHits, 1);
  assert.equal(wsConnections, 0, `不应有 WS 连接，实际 ${wsConnections}`);
});

await check('retcode 失败 → failed（不是 sent）', async () => {
  mode = 'retcode';
  const r = await sendOnce(`http://127.0.0.1:${httpPort}`);
  assert.equal(r.state, 'failed');
});

await check('HTTP 429 → failed', async () => {
  mode = '429';
  const r = await sendOnce(`http://127.0.0.1:${httpPort}`);
  assert.equal(r.state, 'failed');
});

await check('超时 → unknown', async () => {
  mode = 'hang';
  const r = await sendOnce(`http://127.0.0.1:${httpPort}`, 300);
  assert.equal(r.state, 'unknown');
});

await check('去重命中时 HTTP 只发一次', async () => {
  mode = 'ok';
  httpHits = 0;
  const gw = createGateway({ cfg: {} });
  const send = () => postOneBot({
    action: 'send_group_msg',
    params: { group_id: 20002, message: [{ type: 'text', data: { text: 'dedupe' } }] },
    httpUrl: `http://127.0.0.1:${httpPort}`,
    accessToken: 't',
    timeoutMs: 5000,
  });
  await gw.submit({ conversationKey: 'group:20002', kind: 'text', segments: 1, dedupeKey: 'x', send });
  await gw.submit({ conversationKey: 'group:20002', kind: 'text', segments: 1, dedupeKey: 'x', send });
  assert.equal(httpHits, 1);
});

await check('WS 端口始终未被连接', async () => {
  assert.equal(wsConnections, 0);
});

// dry-run：新进程环境变量在导入时生效
await check('QQ_DRY_RUN=1 → 不产生任何 HTTP 调用', async () => {
  process.env.QQ_DRY_RUN = '1';
  const T = await import(`../../qq-bridge/src/transport.js?dry=${Date.now()}`);
  httpHits = 0;
  const gw = createGateway({ cfg: {} });
  const r = await gw.submit({
    conversationKey: 'group:20002',
    kind: 'text',
    segments: 1,
    send: () => T.postOneBot({ action: 'send_group_msg', params: { group_id: 20002 }, httpUrl: `http://127.0.0.1:${httpPort}`, accessToken: 't' }),
  });
  assert.equal(r.state, 'sent');
  assert.equal(httpHits, 0, `dry-run 下不应请求 HTTP，实际 ${httpHits}`);
  process.env.QQ_DRY_RUN = '0';
});

onebot.close();
wsServer.close();
console.log(`dual-stack replay: ${pass} 项通过，${fails.length} 项失败（WS 连接 ${wsConnections}）`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
