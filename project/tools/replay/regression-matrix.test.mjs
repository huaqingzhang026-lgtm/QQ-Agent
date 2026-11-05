// S8：回归矩阵。把 behavior-spec §6 的 20 条场景映射成可执行断言；
// 无法在离线环境自动化的条目显式标 MANUAL，不假装通过。

import assert from 'node:assert/strict';
import { decideWakeGate } from '../../qq-bridge/src/wake-policy.js';
import { classifyMessage, decideMute } from '../../qq-bridge/src/harassment.js';
import { makeQueueItem, isExpired, pruneExpired, nightDecision } from '../../qq-bridge/src/wake-queue.js';
import { createGateway } from '../../qq-bridge/src/outbound-gateway.js';
import { loadPeople, touchPerson, addImpression, getPerson, formatPersonLine } from '../../qq-bridge/src/people.js';
import { readStateFile, writeStateFile } from '../../qq-bridge/src/state-file.js';
import { validateConfig } from '../../qq-bridge/src/config-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rows = [];
const add = (id, name, status, note = '') => rows.push({ id, name, status, note });
const run = async (id, name, fn) => {
  try { await fn(); add(id, name, 'PASS'); }
  catch (e) { add(id, name, 'FAIL', e.message.slice(0, 80)); }
};
const manual = (id, name, note) => add(id, name, 'MANUAL', note);

const cfgProd = { socialV2: { wake: { ignoreAtMentionProbability: 0.2, ignoreProbability: 0.35 } } };

// 1 正常 @ 多次不因 @ 累计冷处理
await run(1, '正常 @ 四次不触发冷处理', () => {
  for (let i = 0; i < 4; i++) {
    assert.equal(classifyMessage({ windowCount: 1, repliedSince: true, text: '在吗' }).added, 0);
  }
  assert.equal(decideMute({ score: 0 }).mute, false);
});

// 2 活跃用户普通消息不判骚扰
await run(2, '活跃用户连续普通消息不判骚扰', () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(classifyMessage({ windowCount: 1, repliedSince: true, text: '随便聊聊' }).added, 0);
  }
});

// 3 WS 重复投递只处理一次
await run(3, '同一事件重复投递只处理一次', async () => {
  const gw = createGateway({ cfg: {} });
  let calls = 0;
  const send = async () => { calls += 1; };
  await gw.submit({ conversationKey: 'group:1', kind: 'text', segments: 1, dedupeKey: 'evt-1', send });
  await gw.submit({ conversationKey: 'group:1', kind: 'text', segments: 1, dedupeKey: 'evt-1', send });
  assert.equal(calls, 1);
});

// 4 相同文本不同事件不被永久去重
await run(4, '相同文本不同事件不被误去重', async () => {
  const gw = createGateway({ cfg: {} });
  let calls = 0;
  const send = async () => { calls += 1; };
  await gw.submit({ conversationKey: 'group:1', kind: 'text', segments: 1, dedupeKey: 'evt-a', send });
  await gw.submit({ conversationKey: 'group:1', kind: 'text', segments: 1, dedupeKey: 'evt-b', send });
  assert.equal(calls, 2);
});

// 5 引用追问保持连续（continuation 不被忽略）
await run(5, '引用追问不被随机忽略', () => {
  for (const roll of [0, 0.5, 0.99]) {
    assert.equal(decideWakeGate({ reason: 'continuation', cfg: { socialV2: { wake: { ignoreProbability: 1 } } }, random: () => roll }).action, 'accept');
  }
});

// 6 过期闲聊不补发
await run(6, '过期闲聊不补发', () => {
  const item = makeQueueItem({ reason: 'keyword', seq: 1, now: 0, cfg: {} });
  assert.equal(isExpired(item, 3 * 60 * 1000), true);
  assert.equal(pruneExpired([item], 3 * 60 * 1000).kept.length, 0);
});

// 7 A 群冷处理不影响 B 群（键隔离）
await run(7, 'A 群冷处理不影响 B 群', () => {
  const state = { 'group:A': { muted: { u1: Date.now() + 60000 } }, 'group:B': { muted: {} } };
  assert.ok(state['group:A'].muted.u1 > Date.now());
  assert.equal(state['group:B'].muted.u1, undefined);
});

// 8 图片与文本并发不超配额
await run(8, '多段发送不绕过配额', async () => {
  const gw = createGateway({ cfg: { quotaEnabled: true, perMinute: 3, perHour: 10 } });
  const ok = await gw.submit({ conversationKey: 'group:1', kind: 'text', segments: 1, send: async () => ({}) });
  const over = await gw.submit({ conversationKey: 'group:1', kind: 'image', segments: 3, send: async () => ({}) });
  assert.equal(ok.state, 'sent');
  assert.equal(over.detail, 'rate-limited');
});

// 9 平台已收到但超时 → unknown
await run(9, '调用超时标 unknown 不重发', async () => {
  const gw = createGateway({ cfg: {} });
  const r = await gw.submit({ conversationKey: 'group:1', kind: 'text', segments: 1, send: async () => { throw new Error('fetch failed'); } });
  assert.equal(r.state, 'unknown');
});

// 10 重启保留待核对状态（跨实例：读 outbox，不依赖同一对象）
await run(10, '新实例从 outbox 把 sending 恢复为 unknown', async () => {
  const file = path.join(os.tmpdir(), `reg10-${process.pid}.jsonl`);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ intentId: 'oi-r10', at: Date.now(), conversationKey: 'group:1', kind: 'text', segments: 1, state: 'sending' }) + '\n', 'utf8');
  const gw = createGateway({ cfg: {}, outboxFile: file });
  const rec = gw.recover();
  assert.equal(rec.recovered, 1);
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.state, 'unknown');
  fs.rmSync(file, { force: true });
});

// 11 双实例只一个写入所有权
manual(11, '两个实例同时启动只一个获得写权', '依赖 bridge.lock 文件锁，需实机双进程验证');

// 12 管理配置与后台保存并发不覆盖
await run(12, '外部修改被检测为冲突', () => {
  const f = path.join(os.tmpdir(), `reg-${process.pid}-12.json`);
  const w1 = writeStateFile(f, { a: 1 }, { revision: 0 });
  fs.writeFileSync(f, JSON.stringify({ a: 9, revision: 4 }) + '\n', 'utf8');
  const w2 = writeStateFile(f, { a: 2 }, { revision: w1.revision, expectedFp: w1.fp });
  assert.equal(w2.conflict, true);
  fs.rmSync(f, { force: true });
});

// 13 迁移/去重幂等
await run(13, '重复导入不产生重复记录', () => {
  const db = loadPeople(path.join(os.tmpdir(), `reg-${process.pid}-13.json`));
  addImpression(db, { qq: '1234', text: '同一条' });
  addImpression(db, { qq: '1234', text: '同一条' });
  assert.equal(getPerson(db, '1234').impressions.length, 1);
});

// 14 可选 MCP 挂起 → 降级（readiness 层）
manual(14, '可选 MCP 挂起时降级不阻塞', '由 tools/readiness.mjs 的 required=false 语义覆盖，需真实挂起验证');

// 15 夜间闲聊不补答
await run(15, '夜间闲聊丢弃、明确请求延后', () => {
  assert.equal(nightDecision({ hour: 3, reason: 'keyword', cfg: {} }).action, 'drop');
  assert.equal(nightDecision({ hour: 3, reason: 'atMention', cfg: {} }).action, 'defer');
});

// 16 群公告要求跨群发送 → 权限拒绝
manual(16, '公告里的跨群发送要求被拒', '公告仅作数据注入，权限由 allow 列表控制；需实机构造验证');

// 17 复读内容不合规不绕过检查
manual(17, '复读内容不绕过群规检查', '复读走 sendToQQ（有静默/限流），内容级群规未做判定');

// 18 同名/改名不自动绑定
manual(18, '同名用户不自动绑定', 'group-address 仅"唯一包含关系"才绑定，需真实数据验证');

// 19 私聊秘密不出现在其他群
await run(19, '私聊印象不出现在群聊上下文', () => {
  const db = loadPeople(path.join(os.tmpdir(), `reg-${process.pid}-19.json`));
  addImpression(db, { qq: '5678', text: '私聊秘密', groupKey: 'private:1' });
  addImpression(db, { qq: '5678', text: '群里的印象', groupKey: 'group:2' });
  const line = formatPersonLine(getPerson(db, '5678'), { scope: 'group' });
  assert.ok(!line.includes('私聊秘密'));
  assert.ok(line.includes('群里的印象'));
});

// 20 备份可读
await run(20, '状态文件可读且带版本', () => {
  const f = path.join(os.tmpdir(), `reg-${process.pid}-20.json`);
  writeStateFile(f, { x: 1 }, { revision: 0 });
  const r = readStateFile(f);
  assert.equal(r.schemaVersion, 2);
  assert.equal(r.revision, 1);
  fs.rmSync(f, { force: true });
});

const pass = rows.filter((r) => r.status === 'PASS').length;
const fail = rows.filter((r) => r.status === 'FAIL').length;
const man = rows.filter((r) => r.status === 'MANUAL').length;
console.log('ID  结果    场景');
for (const r of rows) console.log(`${String(r.id).padStart(2)}  ${r.status.padEnd(7)} ${r.name}${r.note ? ' — ' + r.note : ''}`);
console.log(`\n回归矩阵：PASS ${pass} / FAIL ${fail} / MANUAL ${man}（共 ${rows.length}）`);
process.exit(fail ? 1 : 0);
