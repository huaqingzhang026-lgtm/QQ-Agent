// 回放：外发网关 v2（并发/去重/配额/unknown/恢复/持久化）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway, classifyResult } from '../../qq-bridge/src/outbound-gateway.js';

const KEY = 'group:20001';
let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const tmpOutbox = () => path.join(os.tmpdir(), `outbox-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
const gwOf = (cfg = {}, outboxFile = null) => createGateway({ cfg, outboxFile });

await check('成功 → sent', async () => {
  const gw = gwOf();
  const r = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => ({ ok: true }) });
  assert.equal(r.state, 'sent');
});

await check('业务失败（ok=false）→ failed，不再记 sent', async () => {
  const gw = gwOf({ quotaEnabled: true, perMinute: 5, perHour: 5 });
  const r = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => ({ ok: false, status: 429 }) });
  assert.equal(r.state, 'failed');
  // 配额已释放：下一次仍能发
  const ok = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => ({ ok: true }) });
  assert.equal(ok.state, 'sent');
});

await check('抛异常（超时/网络）→ unknown', async () => {
  const gw = gwOf();
  const r = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => { throw new Error('fetch failed'); } });
  assert.equal(r.state, 'unknown');
});

await check('classifyResult 三分类', () => {
  assert.equal(classifyResult({ ok: true }), 'sent');
  assert.equal(classifyResult({ ok: false }), 'failed');
  assert.equal(classifyResult({ unknown: true }), 'unknown');
});

await check('目标未授权 → failed', async () => {
  const gw = gwOf();
  const r = await gw.submit({ conversationKey: 'group:999', kind: 'text', segments: 1, allowedKeys: [KEY], send: async () => ({ ok: true }) });
  assert.equal(r.detail, 'target-not-allowed');
});

await check('顺序去重', async () => {
  const gw = gwOf();
  let calls = 0;
  const send = async () => { calls += 1; return { ok: true }; };
  await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'd1', send });
  const second = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'd1', send });
  assert.equal(calls, 1);
  assert.equal(second.duplicate, true);
});

await check('并发去重：同一事件只发一次', async () => {
  const gw = gwOf();
  let calls = 0;
  const send = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { ok: true }; };
  const [a, b] = await Promise.all([
    gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'same', send }),
    gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'same', send }),
  ]);
  assert.equal(calls, 1);
  assert.ok([a.duplicate, b.duplicate].includes(true));
});

await check('并发配额：额度 1 时只发一次', async () => {
  const gw = gwOf({ quotaEnabled: true, perMinute: 1, perHour: 10 });
  let calls = 0;
  const send = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { ok: true }; };
  const [a, b] = await Promise.all([
    gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send }),
    gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual([a.state, b.state].sort(), ['failed', 'sent']);
});

await check('unknown 保留配额占用', async () => {
  const gw = gwOf({ quotaEnabled: true, perMinute: 1, perHour: 10 });
  const first = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => { throw new Error('timeout'); } });
  const second = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => ({ ok: true }) });
  assert.equal(first.state, 'unknown');
  assert.equal(second.state, 'failed');
  assert.equal(second.detail, 'rate-limited');
});

await check('多段消息按段扣额度', async () => {
  const gw = gwOf({ quotaEnabled: true, perMinute: 3, perHour: 10 });
  const blocked = await gw.submit({ conversationKey: KEY, kind: 'burst', segments: 4, send: async () => ({ ok: true }) });
  assert.equal(blocked.detail, 'rate-limited');
});

await check('outbox 落盘后再发送（顺序可验证）', async () => {
  const file = tmpOutbox();
  const gw = gwOf({}, file);
  await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'k', send: async () => ({ ok: true }) });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].state, 'reserved');
  assert.equal(lines.at(-1).state, 'sent');
  fs.rmSync(file, { force: true });
});

await check('outbox 不可写 → 不发送', async () => {
  const dir = path.join(os.tmpdir(), `gw-bad-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a dir', 'utf8');
  const gw = gwOf({}, path.join(dir, 'outbox.jsonl'));
  let calls = 0;
  const r = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => { calls += 1; return { ok: true }; } });
  assert.equal(r.detail, 'outbox-write-failed');
  assert.equal(calls, 0);
  fs.rmSync(dir, { force: true });
});

await check('新实例从 outbox 恢复：sending → unknown', async () => {
  const file = tmpOutbox();
  const gw1 = gwOf({}, file);
  // 模拟"发送中进程消失"：直接写一条 sending 记录
  fs.writeFileSync(file, `${JSON.stringify({ intentId: 'oi-x', at: Date.now(), conversationKey: KEY, kind: 'text', segments: 1, state: 'sending', dedupeKey: KEY + '|text|e1' })}\n`, 'utf8');
  const gw2 = gwOf({}, file);
  const rec = gw2.recover();
  assert.equal(rec.recovered, 1);
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.state, 'unknown');
  fs.rmSync(file, { force: true });
});

await check('新实例恢复 sent 记录用于去重', async () => {
  const file = tmpOutbox();
  const gw1 = gwOf({}, file);
  await gw1.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'persist', send: async () => ({ ok: true }) });
  const gw2 = gwOf({}, file);
  gw2.recover();
  let calls = 0;
  const dup = await gw2.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'persist', send: async () => { calls += 1; return { ok: true }; } });
  assert.equal(dup.duplicate, true);
  assert.equal(calls, 0);
  fs.rmSync(file, { force: true });
});

await check('去重作用域含会话', async () => {
  const gw = gwOf();
  let calls = 0;
  const send = async () => { calls += 1; return { ok: true }; };
  await gw.submit({ conversationKey: 'group:A', kind: 'text', segments: 1, dedupeKey: 'x', send });
  await gw.submit({ conversationKey: 'group:B', kind: 'text', segments: 1, dedupeKey: 'x', send });
  assert.equal(calls, 2);
});

await check('去重过期后可再发', async () => {
  const gw = createGateway({ cfg: { dedupeTtlMs: 10 }, now: () => Date.now() });
  let calls = 0;
  const send = async () => { calls += 1; return { ok: true }; };
  await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'e', send });
  await new Promise((r) => setTimeout(r, 20));
  await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, dedupeKey: 'e', send });
  assert.equal(calls, 2);
});

await check('配额关闭时不拦截', async () => {
  const gw = gwOf({ quotaEnabled: false, perMinute: 1 });
  for (let i = 0; i < 5; i++) {
    const r = await gw.submit({ conversationKey: KEY, kind: 'text', segments: 1, send: async () => ({ ok: true }) });
    assert.equal(r.state, 'sent');
  }
});

console.log(`outbound-gateway v2 replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
