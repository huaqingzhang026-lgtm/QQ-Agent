const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
const { createTurnCollector } = await import(pathToFileURL(path.join(CANDIDATE_ROOT, 'qq-bridge/src/dsh-client.js')).href);
// A03-rework3 H01：真实 deliverPromptNow 的执行身份贯穿。
// 真实候选函数切片 + 受控 session/media/provider/transport；不是完整进程 E2E。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { makeWorld, seedDecision, extract, now } from './bridge-fixture.mjs';

const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (error) { results.push({ id, ok: false, error: String(error?.stack ?? error) }); }
}
function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function harness({ dshReady = true, ensureSession = null, mediaWait = null } = {}) {
  const w = makeWorld();
  w.st.unread = Array.isArray(w.st.unread) ? w.st.unread : [];
  const queued = new Map();
  const submissions = [];
  const builds = [];
  const errors = [];
  const retries = [];
  let resolveMedia = null;
  const mediaPromise = mediaWait ? new Promise((resolve) => { resolveMedia = resolve; }) : null;
  Object.assign(w.ctx, {
    dshReady,
    queued,
    QUEUE_MAX: 50,
    pendingWakeKeys: new Set(),
    wakeReadThrough: new Map(),
    social: { exitingSessions: new Set() },
    canonicalV2Key: (key) => key,
    disarmPendingWakeLease: () => {},
    releaseWakeOwnership: undefined,
    ensureSession: ensureSession || (async () => 'sess-1'),
    withSlangContext: (text) => text,
    buildWakePromptV2: (key, reason, overrides) => { builds.push({ key, reason, overrides }); return 'PROMPT:' + (overrides?.neutral === true ? 'NEUTRAL' : (overrides?.execution?.executionId || 'NONE')); },
    buildWakeSnapshotV2: () => null,
    resolveMediaList: async () => { if (mediaPromise) await mediaPromise; return [{ type: 'image', data: 'x' }]; },
    findMessageMedia: () => [],
    isCurrentSession: (key, sid) => String(sid) === 'sess-1',
    submitRoutedPrompt: async (input) => { submissions.push(input); return { result: { ok: true, value: {} } }; },
    sendToQQ: async () => {},
    shouldAuditKey: () => false,
    SENSITIVE_RE: /$^/,
    auditAndSend: async () => {},
    mdToPlain: (x) => x,
    noteModelMessagesV2: () => {},
    enqueueForRetry: (key, promptText, opts) => { retries.push({ key, promptText, opts }); },
    schedulePendingWakeContinuationV2: undefined,
    log: (line) => errors.push(String(line)),
  });
  const src = extract('async function deliverPromptNow(', 'function deliverPrompt(key');
  vm.runInContext(src, w.ctx);
  return { w, queued, submissions, builds, errors, retries, resolveMedia };
}

await test('valid-final-dispatch-once-with-same-execution', async () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId, decisionId: execution.decisionId, executionEpoch: execution.epoch, executionSeq: execution.seq });
  assert.equal(result.ok, true);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].executionId, execution.executionId);
  assert.equal(h.builds.length, 1);
  assert.equal(h.builds[0].overrides.execution.executionId, execution.executionId);
  return { submissions: h.submissions.length, executionId: execution.executionId.slice(0, 6) };
});

await test('ensureSession-replacement-abandons-old-task', async () => {
  let h;
  h = harness({ ensureSession: async () => { h.w.ctx.cancelActiveExecution(h.w.st, 'new-message'); seedDecision(h.w); return 'sess-1'; } });
  const { execution } = seedDecision(h.w);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId });
  assert.equal(result.skipped, true);
  assert.match(result.code, /execution-(cancelled|replaced)/);
  assert.equal(h.submissions.length, 0);
  assert.equal(h.builds.length, 0);
  assert.notEqual(h.w.st.activeExecutionId, execution.executionId);
  return { submissions: 0, code: result.code, current: h.w.st.activeExecutionId.slice(0, 6) };
});

await test('cancel-during-ensureSession-abandons-old-task', async () => {
  let h;
  h = harness({ ensureSession: async () => { h.w.ctx.invalidateActiveDecision(h.w.st, 'new-message'); return 'sess-1'; } });
  const { execution } = seedDecision(h.w);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId });
  assert.equal(h.submissions.length, 0);
  assert.equal(result.skipped, true);
  assert.match(result.code, /execution-(cancelled|replaced)/);
  return { submissions: 0, code: result.code };
});

await test('new-message-during-media-abandons-old-task', async () => {
  const h = harness({ mediaWait: true });
  const { execution } = seedDecision(h.w);
  const pending = h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId, media: [{ kind: 'image', file: 'x.png' }] });
  await tick();
  h.w.st.lastUnreadSeq = 8;
  h.w.st.unread.push({ seq: 8, messageId: 'm8', userId: '2', text: '补充一句' });
  h.w.ctx.invalidateActiveDecision(h.w.st, 'new-message');
  h.resolveMedia();
  const result = await pending;
  assert.equal(h.submissions.length, 0);
  assert.equal(result.skipped, true);
  assert.match(result.code, /execution-(cancelled|replaced|stale)/);
  return { submissions: 0, code: result.code };
});

await test('offline-queue-carries-immutable-execution-identity', async () => {
  const h = harness({ dshReady: false });
  const { execution } = seedDecision(h.w);
  const r1 = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId, decisionId: execution.decisionId, executionEpoch: execution.epoch, executionSeq: execution.seq, leaseToken: 'lease-old' });
  assert.equal(r1.queued, true);
  const item = h.queued.get('private:1')[0];
  assert.equal(item.executionId, execution.executionId);
  assert.equal(item.decisionId, execution.decisionId);
  assert.equal(item.executionEpoch, execution.epoch);
  assert.equal(item.executionSeq, execution.seq);
  // DSH 恢复时消息已更新：同一个排队项必须失效，不能拿新凭证补发旧内容。
  h.w.ctx.dshReady = true;
  h.w.st.lastUnreadSeq = 8;
  h.w.st.unread.push({ seq: 8, messageId: 'm8', userId: '2', text: '新消息' });
  h.w.ctx.invalidateActiveDecision(h.w.st, 'new-message');
  const r2 = await h.w.ctx.deliverPromptNow('private:1', item.promptText, item);
  assert.equal(r2.skipped, true);
  assert.equal(h.submissions.length, 0);
  return { queuedExecution: item.executionId.slice(0, 6), flushCode: r2.code, submissions: 0 };
});

await test('expired-execution-never-delivers', async () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  h.w.setClock(now + 7 * 60 * 1000);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId });
  assert.equal(h.submissions.length, 0);
  assert.equal(result.code, 'execution-expired');
  return { submissions: 0, code: result.code };
});

await test('revision-change-never-delivers', async () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  h.w.setSnapshot({ revision: 4, state: h.w.getSnapshot().state });
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId });
  assert.equal(h.submissions.length, 0);
  assert.equal(result.code, 'execution-stale-revision');
  return { submissions: 0, code: result.code };
});

await test('session-changed-during-ensureSession-never-delivers', async () => {
  const h = harness({ ensureSession: async () => 'sess-2' });
  const { execution } = seedDecision(h.w);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId });
  assert.match(result.code, /session-changed/);
  assert.equal(h.submissions.length, 0);
  return { submissions: 0, code: result.code };
});

await test('legitimate-new-task-still-delivers-after-old-abort', async () => {
  const h = harness();
  const old = seedDecision(h.w).execution;
  h.w.ctx.cancelActiveExecution(h.w.st, 'new-message');
  const second = seedDecision(h.w).execution;
  const oldResult = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: old.executionId });
  const newResult = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: second.executionId });
  assert.equal(oldResult.skipped, true);
  assert.equal(newResult.ok, true);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].executionId, second.executionId);
  return { oldCode: oldResult.code, submissions: 1 };
});

await test('uncredentialed-wake-with-personality-on-is-refused', async () => {
  const h = harness();
  seedDecision(h.w);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at' });
  assert.equal(result.skipped, true);
  assert.equal(result.code, 'execution-missing');
  assert.equal(h.submissions.length, 0);
  return { submissions: 0, code: result.code };
});

await test('neutral-wake-with-personality-off-delivers-without-execution', async () => {
  const h = harness();
  h.w.ctx.personalityEnabled = () => false;
  const result = await h.w.ctx.deliverPromptNow('private:1', 'neutral-prompt', { wakeReason: 'at', personality: false });
  assert.equal(result.ok, true);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].executionId, '');
  assert.equal(h.builds[0].overrides.neutral, true);
  return { submissions: 1, executionId: '', neutral: true };
});

await test('neutral-wake-aborts-if-personality-reenabled-before-submit', async () => {
  let h;
  h = harness({ ensureSession: async () => { h.w.ctx.personalityEnabled = () => true; return 'sess-1'; } });
  h.w.ctx.personalityEnabled = () => false;
  const result = await h.w.ctx.deliverPromptNow('private:1', 'neutral-prompt', { wakeReason: 'at', personality: false });
  assert.equal(result.skipped, true);
  assert.equal(result.code, 'personality-reenabled');
  assert.equal(h.submissions.length, 0);
  return { submissions: 0, code: result.code };
});

await test('retry-enqueue-keeps-execution-identity', async () => {
  const h = harness({ ensureSession: async () => { throw new Error('会话创建期间已重置'); } });
  const { execution } = seedDecision(h.w);
  const result = await h.w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: execution.executionId, decisionId: execution.decisionId, leaseToken: 'lease-1' });
  assert.equal(result.retried, true);
  assert.equal(h.retries.length, 1);
  assert.equal(h.retries[0].opts.executionId, execution.executionId);
  assert.equal(h.submissions.length, 0);
  return { retried: true, executionId: h.retries[0].opts.executionId.slice(0, 6) };
});

await test('first-session-binds-execution-session-id-without-changing-credential', async () => {
  const h = harness();
  const w = h.w;
  const d = w.ctx.buildDecision({ key: 'private:1', snapshot: w.getSnapshot(), text: '在吗', now, ttlMs: 360000 });
  const ex = w.ctx.createExecutionContext({ key: 'private:1', decision: d, sessionId: null, epoch: w.st.decisionEpoch, seq: 7, now, ttlMs: 360000 });
  w.st.activeDecision = d; w.st.activeDecisionSeq = 7; w.st.activeExecution = ex; w.st.activeExecutionId = ex.executionId;
  w.ctx.executionContexts.set(ex.executionId, ex);
  const result = await w.ctx.deliverPromptNow('private:1', 'legacy-prompt', { wakeReason: 'at', executionId: ex.executionId });
  assert.equal(result.ok, true);
  assert.equal(ex.sessionId, 'sess-1');
  assert.equal(w.st.activeExecutionId, ex.executionId);
  assert.equal(h.submissions.length, 1);
  return { submissions: 1, sessionId: ex.sessionId, executionIdUnchanged: true };
});

await test('serial-queue-preserves-each-items-execution-identity', async () => {
  const w = makeWorld();
  const promptQueues = new Map();
  const calls = [];
  let releaseFirst;
  w.ctx.promptQueues = promptQueues;
  w.ctx.deliverPromptNow = async (key, prompt, opts) => {
    calls.push({ key, prompt, opts });
    if (calls.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return { ok: true };
  };
  vm.runInContext(extract('function deliverPrompt(key', 'function scheduleSocialReply('), w.ctx);
  const first = w.ctx.deliverPrompt('private:1', 'p1', { executionId: 'exec-1', wakeReason: 'at' });
  const second = w.ctx.deliverPrompt('private:1', 'p2', { executionId: 'exec-2', wakeReason: 'at' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.executionId, 'exec-1');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.executionId, 'exec-2');
  return { queued: 2, first: calls[0].opts.executionId, second: calls[1].opts.executionId };
});

await test('submit-routed-prompt-rechecks-after-model-selection', async () => {
  const w = makeWorld();
  const prompts = [];
  const dispatches = [];
  Object.assign(w.ctx, {
    cfg: { dsh: { reasoningEffort: 'low' } },
    api: { sessions: { selectModel: async () => { await tick(); }, prompt: async (input) => { prompts.push(input); return { result: { ok: true, value: {} } }; } } },
    chainForTask: () => [{ provider: 'p', model: 'm' }],
    showTypingIndicator: () => {},
    normalizeRouting: () => ({ firstOutputTimeoutMs: 999999, timeoutDowngrade: false }),
    setTimeout: (fn) => ({ fn, unref() { return this; } }),
    pendingRoute: new Map(),
    v2TurnMeta: new Map(),
    armMentionDeadline: () => {},
    noteTurnDispatch: (sid, eid) => dispatches.push({ sid, eid }),
    withdrawTurnDispatch: () => {},
    nextModel: () => null,
    mimoReplyOrThrow: async () => { throw new Error('no fallback'); },
    REASONING_EFFORT_DEFAULT: 'low',
    log: () => {},
  });
  vm.runInContext(extract('async function submitRoutedPrompt(', 'async function mimoReplyOrThrow('), w.ctx);
  let error = null;
  try {
    await w.ctx.submitRoutedPrompt({ key: 'private:1', sessionId: 'sess-1', content: [], promptText: 'p', executionId: 'exec-old', beforeSubmit: () => ({ ok: false, code: 'execution-replaced' }) });
  } catch (e) { error = e; }
  assert.equal(prompts.length, 0);
  assert.equal(error?.code, 'execution-replaced');
  await w.ctx.submitRoutedPrompt({ key: 'private:1', sessionId: 'sess-1', content: [], promptText: 'p', executionId: 'exec-new', beforeSubmit: () => ({ ok: true }) });
  assert.equal(prompts.length, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].eid, 'exec-new');
  return { blockedBeforePrompt: true, acceptedAfterPrompt: 1 };
});

await test('real-submit-registers-turn-and-start-binds-end-cancels', async () => {
  const w = makeWorld();
  const turnExecutionMap = new Map();
  const collectors = new Map();
  const v2TurnStartAt = new Map();
  const turnLeaseNoted = new Set();
  Object.assign(w.ctx, {
    turnExecutionMap, collectors, v2TurnStartAt, turnLeaseNoted,
    reverse: new Map([['sess-1', 'private:1']]),
    createTurnCollector,
    saveSocialV2State: () => {},
    cfg: { ...w.ctx.cfg, dsh: { reasoningEffort: 'low' } },
    api: { sessions: { selectModel: async () => {}, prompt: async () => ({ result: { ok: true, value: {} } }) } },
    chainForTask: () => [{ provider: 'p', model: 'm' }],
    showTypingIndicator: () => {},
    normalizeRouting: () => ({ firstOutputTimeoutMs: 999999, timeoutDowngrade: false }),
    setTimeout: (fn) => ({ fn, unref() { return this; } }),
    pendingRoute: new Map(),
    v2TurnMeta: new Map(),
    armMentionDeadline: () => {},
    nextModel: () => null,
    mimoReplyOrThrow: async () => { throw new Error('no fallback'); },
    REASONING_EFFORT_DEFAULT: 'low',
    log: () => {},
  });
  vm.runInContext(extract('function bindTurnExecution(', 'async function pumpMux('), w.ctx);
  vm.runInContext(extract('async function submitRoutedPrompt(', 'async function mimoReplyOrThrow('), w.ctx);
  const { execution } = seedDecision(w);
  await w.ctx.submitRoutedPrompt({ key: 'private:1', sessionId: 'sess-1', content: [], promptText: 'p', executionId: execution.executionId, beforeSubmit: () => ({ ok: true }) });
  w.ctx.trackTurnEvent('sess-1', { type: 'turn/start', data: { turn: 't-real' } });
  assert.equal(turnExecutionMap.get('sess-1:t-real'), execution.executionId);
  assert.equal(execution.turnId, 't-real');
  w.ctx.trackTurnEvent('sess-1', { type: 'turn/end', data: { turn: 't-real', reason: { kind: 'completed' } } });
  const after = w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId);
  assert.equal(after.ok, false);
  return { registered: 1, bound: 't-real', after: after.ok };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-h01-dispatch-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
