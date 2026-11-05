// A03-rework3 H03：人格模块开关与普通聊天分离。
// 真实 personalityEnabled/resolveWakeDecision/sendWakePromptV2；传输与时钟受控。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { makeWorld, seedDecision, extract } from './bridge-fixture.mjs';

const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (error) { results.push({ id, ok: false, error: String(error?.stack ?? error) }); }
}
function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function switchWorld() {
  const w = makeWorld();
  const st = w.st;
  st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '在吗' }];
  st.lastUnreadSeq = 7;
  st.wakeTimes = [];
  st.wakeConfig = {};
  const deliveries = [];
  const builds = [];
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
    buildWakePromptV2: (key, reason, overrides) => { builds.push({ key, reason, overrides }); return overrides?.neutral ? 'PROMPT:NEUTRAL' : 'PROMPT:EXEC'; },
    deliverPrompt: async (key, prompt, opts) => { deliveries.push({ key, prompt, opts }); return { ok: true }; },
    clearTimeout: () => {},
    setTimeout: (fn) => ({ fn, unref() { return this; } }),
    setupSleepTimerV2: () => {},
    isExpired: () => false,
    pruneExpired: (list) => ({ kept: list, expired: [] }),
    makeQueueItem: ({ reason, seq, at }) => ({ reason, seq, at: at ?? Date.now(), expiresAt: 0 }),
    ttlFor: () => 0,
    saveSocialV2State: () => {},
    log: () => {},
    refreshGroupInfoV2: async () => {},
  });
  vm.runInContext(extract('function isConversationBusyV2(', 'async function notifyMentionFailure(') + '\n' + extract('async function sendWakePromptV2(', 'function cancelReplyCheckV2('), w.ctx);
  w.ctx.releaseWakeOwnership = (key) => { w.ctx.pendingWakeKeys.delete(key); };
  return { w, st, deliveries, builds };
}

await test('personality-on-reserved2-delivers-with-execution', async () => {
  const h = switchWorld();
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].opts.personality, undefined);
  assert.ok(h.deliveries[0].opts.executionId);
  assert.equal(h.st.activeExecution.executionId, h.deliveries[0].opts.executionId);
  return { deliveries: 1, execution: h.deliveries[0].opts.executionId.slice(0, 6) };
});

await test('personality-off-keeps-neutral-chat-without-execution', async () => {
  const h = switchWorld();
  h.w.ctx.personalityEnabled = () => false;
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].opts.personality, false);
  assert.equal(h.deliveries[0].opts.executionId ?? '', '');
  assert.equal(h.builds[0].overrides.neutral, true);
  assert.equal(h.deliveries[0].prompt, 'PROMPT:NEUTRAL');
  assert.equal(h.st.activeExecution ?? null, null);
  return { deliveries: 1, neutral: true, execution: null };
});

await test('socialV2-off-stops-all-wakes', async () => {
  const h = switchWorld();
  h.w.ctx.cfg.socialV2.enabled = false;
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.deliveries.length, 0);
  return { deliveries: 0 };
});

await test('paused-stops-all-wakes', async () => {
  const h = switchWorld();
  h.w.ctx.socialV2.paused = true;
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.deliveries.length, 0);
  return { deliveries: 0 };
});

await test('re-enable-rejects-old-credential-and-accepts-new-turn', async () => {
  const h = switchWorld();
  const old = seedDecision(h.w).execution;
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', old.executionId).ok, true);
  h.w.ctx.personalityEnabled = () => false;
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.deliveries.length, 1);
  assert.equal(old.cancelledAt > 0, true);
  // 模拟普通聊天回合已结束：pendingWakeKeys 在 turn/end 清除。
  h.w.ctx.pendingWakeKeys.clear();
  h.w.ctx.personalityEnabled = () => true;
  const oldAfter = h.w.ctx.decisionSendGuard('private:1', 'send_message', old.executionId);
  assert.equal(oldAfter.ok, false);
  assert.match(oldAfter.code, /execution-cancelled|decision-missing/);
  await h.w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(h.deliveries.length, 2);
  const fresh = h.deliveries[1].opts.executionId;
  assert.ok(fresh && fresh !== old.executionId);
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', fresh).ok, true);
  return { oldBlocked: oldAfter.code, freshAllowed: true, fresh: fresh.slice(0, 6) };
});

await test('non-personality-text-send-is-not-blocked-by-execution', async () => {
  const h = switchWorld();
  h.w.ctx.personalityEnabled = () => false;
  const sent = await h.w.ctx.sendMessagesV2('private:1', ['普通回复'], [], null, null, {});
  assert.equal(sent.length, 1);
  assert.equal(h.w.transports.length, 1);
  return { transports: 1 };
});

await test('personality-off-image-guard-allows-bridge-path-without-credential', async () => {
  const h = switchWorld();
  h.w.ctx.personalityEnabled = () => false;
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'image', '').ok, true);
  h.w.ctx.personalityEnabled = () => true;
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'image', '').code, 'execution-missing');
  return { disabledAllows: true, enabledRejects: 'execution-missing' };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-h03-switch-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
