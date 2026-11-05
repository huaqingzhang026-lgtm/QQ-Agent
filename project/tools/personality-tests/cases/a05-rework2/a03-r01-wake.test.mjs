// A03-rework3 适配：attach 失效后释放唤醒槽，下一次合法唤醒仍能投递。
// 接口变化：sendWakePromptV2 现在使用结构化 resolveWakeDecision（disabled/decision/cancelled/degraded）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { makeWorld, extract } from './bridge-fixture.mjs';

const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

await test('failed-attach-releases-lease-next-wake-works', async () => {
  const w = makeWorld();
  w.st.wakeTimes = [];
  w.st.wakeConfig = {};
  const delivered = [];
  Object.assign(w.ctx, {
    isSilentConversationV2: () => false, pendingWakeKeys: new Set(), promptQueues: new Map(),
    v2TurnStartAt: new Map(), collectors: new Map(), turnLeaseNoted: new Set(), TURN_BUSY_LEASE_MS: 60000,
    cancelReplyCheckV2: () => {}, armPendingWakeLease: () => {}, disarmPendingWakeLease: () => {},
    buildWakePromptV2: () => w.st.activeExecutionId || 'NO_CREDENTIAL',
    deliverPrompt: async (key, prompt) => { delivered.push(prompt); return { ok: true }; },
    clearTimeout, setupSleepTimerV2: () => {},
  });
  vm.runInContext(extract('function isConversationBusyV2(', 'async function notifyMentionFailure(') + '\n' + extract('async function sendWakePromptV2(', 'function cancelReplyCheckV2('), w.ctx);
  w.ctx.releaseWakeOwnership = (key) => { w.ctx.pendingWakeKeys.delete(key); };
  let n = 0;
  w.ctx.resolveWakeDecision = async () => {
    n += 1;
    if (n === 1) return { status: 'cancelled', code: 'test-cancelled', decision: null, execution: null };
    w.st.activeExecution = { executionId: 'exec-next', decisionId: 'dec-next', cancelledAt: 0, seq: 7, epoch: w.st.decisionEpoch, key: 'private:1' };
    w.st.activeExecutionId = 'exec-next';
    return { status: 'decision', decision: { decisionId: 'dec-next' }, execution: w.st.activeExecution };
  };
  await w.ctx.sendWakePromptV2('private:1', 'at');
  assert.equal(delivered.length, 0);
  assert.equal(w.st.wakeLease ?? null, null);
  await w.ctx.sendWakePromptV2('private:1', 'timer');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0], 'exec-next');
  assert.equal(w.st.wakeLease ?? null, null);
  return { deliveries: delivered.length, prompt: delivered[0] };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-r01-wake-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
