// A03-rework3 H02：provider 期间新消息使旧唤醒失效后，pending 唤醒自动接续。
// 真实 sendWakePromptV2 / replayPendingWakeReasonsV2；批次调度用受控替身，不靠随机 sleep。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { makeWorld, extract, now } from './bridge-fixture.mjs';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const queue = await import(pathToFileURL(path.join(C, 'qq-bridge/src/wake-queue.js')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (error) { results.push({ id, ok: false, error: String(error?.stack ?? error) }); }
}
function tick() { return new Promise((resolve) => setImmediate(resolve)); }
async function flush(n = 6) { for (let i = 0; i < n; i += 1) await tick(); }

function wakeWorld() {
  const resolvers = [];
  const provider = ({ codeDecision }) => new Promise((resolve) => resolvers.push(() => resolve(codeDecision)));
  const w = makeWorld({ provider });
  const st = w.st;
  st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '第 7 条消息' }];
  st.lastUnreadSeq = 7;
  st.wakeTimes = [];
  st.pendingWakeReasons = [];
  st.wakeConfig = {};
  const timers = [];
  const deliveries = [];
  const logs = [];
  Object.assign(w.ctx, {
    isSilentConversationV2: () => false,
    pendingWakeKeys: new Set(),
    promptQueues: new Map(),
    v2TurnStartAt: new Map(),
    collectors: new Map(),
    turnLeaseNoted: new Set(),
    TURN_BUSY_LEASE_MS: 60000,
    cancelReplyCheckV2: () => {},
    armPendingWakeLease: () => {},
    disarmPendingWakeLease: () => {},
    buildWakePromptV2: (key, reason, overrides) => 'PROMPT:' + (overrides?.neutral ? 'NEUTRAL' : (overrides?.execution?.executionId || 'NONE')),
    deliverPrompt: async (key, prompt, opts) => { deliveries.push({ key, prompt, opts }); return { ok: true }; },
    setTimeout: (fn, ms) => { const handle = { fn, ms, unref() { return handle; } }; timers.push(handle); return handle; },
    clearTimeout: () => {},
    setupSleepTimerV2: () => {},
    scheduleReplyCheckV2: () => {},
    // 受控批次替身：立即进入下一次真实 wake，避免依赖 8s 真实定时器。
    scheduleWakeV2: (key, reason) => { void w.ctx.sendWakePromptV2(key, reason).catch((error) => logs.push(String(error?.stack ?? error))); },
    saveSocialV2State: () => {},
    log: (line) => logs.push(String(line)),
    refreshGroupInfoV2: async () => {},
    isExpired: queue.isExpired,
    pruneExpired: queue.pruneExpired,
    makeQueueItem: queue.makeQueueItem,
    ttlFor: queue.ttlFor,
  });
  vm.runInContext(
    extract('function isConversationBusyV2(', 'async function notifyMentionFailure(') + '\n' +
    extract('const TIMER_WAKE_REASONS', 'function scheduleWakeV2(') + '\n' +
    extract('function replayPendingWakeReasonsV2(', 'function setupSleepTimerV2(') + '\n' +
    extract('async function sendWakePromptV2(', 'function cancelReplyCheckV2('),
    w.ctx,
  );
  // 只释放本任务持有的 pending 标记；该 helper 在真实代码里与 deliverPromptNow 同处主作用域。
  w.ctx.releaseWakeOwnership = (key) => { w.ctx.pendingWakeKeys.delete(key); };
  return { w, st, timers, deliveries, logs, resolvers };
}
function continuationTimer(h) { return h.st.pendingWakeContinuationTimer || null; }
async function runContinuation(h) {
  const timer = continuationTimer(h);
  assert.ok(timer, 'expected a continuation timer');
  timer.fn();
  await flush();
  return timer;
}

await test('provider-pending-new-message-resumes-once', async () => {
  const h = wakeWorld();
  const first = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  assert.equal(h.resolvers.length, 1);
  h.st.lastUnreadSeq = 8;
  h.st.unread.push({ messageId: 'm8', seq: 8, userId: '2', text: '再补充一句' });
  h.w.ctx.invalidateActiveDecision(h.st, 'new-message');
  const second = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await second; // 繁忙，只入 pending
  assert.equal(h.st.pendingWakeReasons.length, 1);
  h.resolvers[0]();
  await first;
  assert.equal(h.st.wakeLease ?? null, null);
  assert.ok(continuationTimer(h), 'continuation must be scheduled after invalidated wake exits');
  await runContinuation(h);
  assert.equal(h.resolvers.length, 2, 'continuation must start exactly one new provider turn');
  h.resolvers[1]();
  await flush();
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].opts.executionId?.length > 0, true);
  assert.equal(h.deliveries[0].opts.executionSeq, 8);
  assert.equal(h.st.pendingWakeReasons.length, 0);
  assert.equal(h.st.wakeLease ?? null, null);
  return { providerTurns: 2, deliveries: 1, seq: h.deliveries[0].opts.executionSeq, manualThirdWake: false };
});

await test('multiple-pending-messages-coalesce-into-one-delivery', async () => {
  const h = wakeWorld();
  const first = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  h.st.lastUnreadSeq = 8; h.st.unread.push({ messageId: 'm8', seq: 8, userId: '2', text: '第 8 条' });
  h.w.ctx.invalidateActiveDecision(h.st, 'new-message');
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  h.st.lastUnreadSeq = 9; h.st.unread.push({ messageId: 'm9', seq: 9, userId: '2', text: '第 9 条' });
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.st.pendingWakeReasons.length, 2);
  h.resolvers[0]();
  await first;
  await runContinuation(h);
  assert.ok(continuationTimer(h), 'superseded head must advance to the next pending item');
  await runContinuation(h);
  assert.equal(h.resolvers.length, 2);
  h.resolvers[1]();
  await flush();
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].opts.executionSeq, 9);
  assert.equal(h.st.pendingWakeReasons.length, 0);
  return { pendingAtStart: 2, deliveries: 1, seq: 9 };
});

await test('expired-pending-message-is-not-replayed', async () => {
  const h = wakeWorld();
  const first = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  h.st.lastUnreadSeq = 8; h.st.unread.push({ messageId: 'm8', seq: 8, userId: '2', text: '会过期的消息' });
  h.w.ctx.invalidateActiveDecision(h.st, 'new-message');
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  h.resolvers[0]();
  await first;
  assert.ok(continuationTimer(h), 'valid pending item should schedule a continuation first');
  h.st.pendingWakeReasons[0].at = now - 20 * 60 * 1000;
  h.st.pendingWakeReasons[0].expiresAt = now - 10 * 60 * 1000;
  await runContinuation(h);
  assert.equal(h.resolvers.length, 1);
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.st.pendingWakeReasons.length, 0);
  return { deliveries: 0, expiredDropped: true };
});

await test('normal-delivery-does-not-schedule-duplicate', async () => {
  const h = wakeWorld();
  const task = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  h.resolvers[0]();
  await task;
  await flush();
  assert.equal(h.deliveries.length, 1);
  assert.equal(continuationTimer(h), null);
  assert.equal(h.st.pendingWakeReasons.length, 0);
  return { deliveries: 1, continuation: null };
});

await test('in-flight-turn-blocks-continuation-then-recovers', async () => {
  const h = wakeWorld();
  const first = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  h.st.lastUnreadSeq = 8; h.st.unread.push({ messageId: 'm8', seq: 8, userId: '2', text: '再来一条' });
  h.w.ctx.invalidateActiveDecision(h.st, 'new-message');
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  h.w.ctx.collectors.set('sess-1', { size: () => 1 });
  h.w.ctx.v2TurnStartAt.set('sess-1', now);
  h.resolvers[0]();
  await first;
  assert.equal(continuationTimer(h), null, 'must not schedule beside an in-flight turn');
  h.w.ctx.collectors.delete('sess-1');
  h.w.ctx.v2TurnStartAt.delete('sess-1');
  h.w.ctx.schedulePendingWakeContinuationV2('private:1', { reason: 'at', code: 'after-turn' });
  await runContinuation(h);
  assert.equal(h.resolvers.length, 2);
  h.resolvers[1]();
  await flush();
  assert.equal(h.deliveries.length, 1);
  return { blockedWhileTurn: true, deliveredAfterTurn: 1 };
});

await test('failure-releases-lease-and-next-wake-works', async () => {
  const h = wakeWorld();
  const originalDeliver = h.w.ctx.deliverPrompt;
  h.w.ctx.deliverPrompt = async () => { throw new Error('synthetic transport failure'); };
  const first = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  h.resolvers[0]();
  await first;
  assert.equal(h.st.wakeLease ?? null, null);
  assert.equal(h.w.ctx.pendingWakeKeys.has('private:1'), false);
  h.w.ctx.deliverPrompt = originalDeliver;
  const next = h.w.ctx.sendWakePromptV2('private:1', 'at');
  await flush(2);
  assert.equal(h.resolvers.length, 2);
  h.resolvers[1]();
  await next;
  assert.equal(h.deliveries.length, 1);
  return { leaseReleased: true, nextDelivered: 1 };
});

await test('continuation-attempts-are-bounded', async () => {
  const h = wakeWorld();
  h.st.pendingWakeReasons = [{ reason: 'at', seq: 8, at: now, expiresAt: now + 60000 }];
  h.w.ctx.replayPendingWakeReasonsV2 = () => ({ action: 'skipped' });
  for (let i = 0; i < 8; i += 1) {
    h.w.ctx.schedulePendingWakeContinuationV2('private:1', { reason: 'at' });
    const timer = continuationTimer(h);
    assert.ok(timer, 'attempt ' + (i + 1));
    timer.fn();
    await flush(2);
  }
  const result = h.w.ctx.schedulePendingWakeContinuationV2('private:1', { reason: 'at' });
  assert.equal(result.exhausted, true);
  assert.equal(h.st.pendingWakeReasons.length, 1);
  return { attempts: h.st.pendingWakeContinuationAttempts, exhausted: true };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-h02-continuation-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
