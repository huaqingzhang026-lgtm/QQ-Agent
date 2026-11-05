import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const execMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-execution.mjs')).href);
function extract(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a); if (a < 0 || b < 0) throw new Error('marker missing: ' + start); return source.slice(a, b).trim(); }
const guardSrc = extract('function decisionSendGuard(', 'function cancelActiveExecution(');
const cancelSrc = extract('function cancelActiveExecution(', 'function invalidateActiveDecision(');
const invalidateSrc = extract('function invalidateActiveDecision(', 'function loadSocialV2State(');
const captureSrc = extract('function captureSendGuard(', '// 静默模式');
const sendSrc = extract('function sendMessagesV2(', '// 审计范围');
const attachSrc = extract('async function attachWakeDecision(', 'function decisionSendGuard(');
const providerSrc = extract('async function callDecisionProvider(', 'async function attachWakeDecision(');
const now = Date.parse('2026-10-31T00:00:00.000Z');
const snapshotBase = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [] } };

function makeWorld({ provider = null } = {}) {
  let clock = now;
  const transports = [];
  const st = { lastUnreadSeq: 7, activeDecisionSeq: 7, decisionEpoch: 1, activeDecision: null, activeExecution: null, activeExecutionId: '', sendTimes: [], recentMessages: [], wakeConfig: {} };
  let snapshot = { revision: 3, state: snapshotBase.state };
  const store = { loadSnapshot: () => ({ ok: true, snapshot }), dbFile: 'synthetic.sqlite' };
  const ctx = vm.createContext({
    currentMode: 'reserved2', cfg: { socialV2: { personalityV2: { enabled: true, decisionTtlMs: 360000, modelTimeoutMs: 2000 } } },
    ROOT: 'C:/synthetic', STATE_DIR: 'C:/synthetic/state', process: { env: {} }, path,
    Date: class extends Date { static now() { return clock; } constructor(...args) { super(...args); } },
    state: { sessions: { 'private:1': 'sess-1' } },
    socialV2: { conversations: new Map([['private:1', st]]) },
    executionContexts: new Map(),
    getSocialV2State: () => st,
    getPersonalityStore: () => store,
    personalityEnabled: () => true,
    saveSocialV2State: () => {},
    log: () => {},
    appendActivity: () => {},
    sessionPolicy: () => 'policy-1',
    isSessionAllowedInCurrentMode: () => true,
    sleep: async () => {},
    onebotSend: async (...args) => { transports.push(args); return { message_id: String(transports.length) }; },
    sendChain: Promise.resolve(),
    buildDecision: mod.buildDecision,
    decideWithModel: mod.decideWithModel,
    neutralFallback: mod.neutralFallback,
    isDecisionUsable: mod.isDecisionUsable,
    actionAllowed: mod.actionAllowed,
    decisionAudit: mod.decisionAudit,
    createExecutionContext: execMod.createExecutionContext,
    cancelExecutionContext: execMod.cancelExecutionContext,
    validateExecutionContext: execMod.validateExecutionContext,
    recordTransport: execMod.recordTransport,
    executionPromptLine: execMod.executionPromptLine,
  });
  ctx.sendChain = Promise.resolve();
  if (provider) ctx.__A03_DECISION_PROVIDER__ = provider;
  vm.runInContext(guardSrc + '\n' + cancelSrc + '\n' + invalidateSrc + '\n' + captureSrc + '\n' + providerSrc + '\n' + attachSrc + '\n' + sendSrc, ctx);
  return { ctx, st, store, transports, setClock: (v) => { clock = v; }, setSnapshot: (v) => { snapshot = v; }, getSnapshot: () => snapshot };
}
function seedDecision(world, over = {}) {
  const d = mod.buildDecision({ key: 'private:1', snapshot: world.getSnapshot(), text: '这个怎么用？', now, ttlMs: 360000, ...over });
  const ex = execMod.createExecutionContext({ key: 'private:1', decision: d, sessionId: 'sess-1', epoch: world.st.decisionEpoch, seq: 7, now, ttlMs: 360000 });
  world.st.activeDecision = d; world.st.activeDecisionSeq = 7; world.st.activeDecisionAt = now;
  world.st.activeExecution = ex; world.st.activeExecutionId = ex.executionId;
  world.ctx.executionContexts.set(ex.executionId, ex);
  return { decision: d, execution: ex };
}
const results = [];
async function check(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

await check('wake-provider-actually-called-and-valid', async () => {
  let providerCalls = 0;
  const world = makeWorld({ provider: ({ codeDecision }) => { providerCalls++; return { ...codeDecision, decisionId: 'model-decision', evidenceIds: ['m7'], allowedActions: ['send_message', 'reply'] }; } });
  world.st.lastUnreadSeq = 7; world.st.unread = [{ seq: 7, messageId: 'm7', userId: '2', text: '这个怎么用？' }];
  const r = await world.ctx.attachWakeDecision('private:1', 'at');
  assert.equal(providerCalls, 1);
  assert.equal(r.decisionId, 'model-decision');
  assert.ok(world.ctx.executionContexts.get(world.st.activeExecutionId));
  return { providerCalls, decisionId: r.decisionId, executionId: world.st.activeExecutionId.slice(0, 6) };
});

await check('valid-send-reaches-transport-once', async () => {
  const world = makeWorld(); seedDecision(world);
  const sent = await world.ctx.sendMessagesV2('private:1', ['合法回复'], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  assert.equal(sent.length, 1); assert.equal(world.transports.length, 1);
  const ex = world.st.activeExecution; assert.equal(ex.transported.length, 1);
  return { transports: world.transports.length, transported: ex.transported.length };
});

await check('new-message-after-admission-stops-transport', async () => {
  const world = makeWorld(); seedDecision(world);
  const pending = world.ctx.sendMessagesV2('private:1', ['旧回复'], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  world.ctx.invalidateActiveDecision(world.st, 'new-message');
  let error = null; try { await pending; } catch (e) { error = e.message; }
  assert.equal(world.transports.length, 0); assert.ok(error);
  return { transports: world.transports.length, error };
});

await check('ttl-expiry-after-admission-stops-transport', async () => {
  const world = makeWorld(); seedDecision(world);
  const pending = world.ctx.sendMessagesV2('private:1', ['过期回复'], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  world.setClock(now + 7 * 60 * 1000);
  let error = null; try { await pending; } catch (e) { error = e.message; }
  assert.equal(world.transports.length, 0);
  return { transports: world.transports.length, error };
});

await check('revision-change-after-admission-stops-transport', async () => {
  const world = makeWorld(); seedDecision(world);
  const pending = world.ctx.sendMessagesV2('private:1', ['旧状态回复'], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  world.setSnapshot({ revision: 4, state: snapshotBase.state });
  let error = null; try { await pending; } catch (e) { error = e.message; }
  assert.equal(world.transports.length, 0);
  return { transports: world.transports.length, error };
});

await check('partial-first-sent-then-invalidated', async () => {
  const world = makeWorld(); seedDecision(world);
  let invalidated = false;
  world.ctx.onebotSend = async (...args) => { world.transports.push(args); if (!invalidated) { invalidated = true; world.ctx.invalidateActiveDecision(world.st, 'new-message'); } return { message_id: '1' }; };
  let error = null; try { await world.ctx.sendMessagesV2('private:1', ['第一条', '第二条'], [1], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' }); } catch (e) { error = e; }
  assert.equal(world.transports.length, 1); assert.equal(error?.sent?.length, 1);
  return { transports: world.transports.length, sent: error?.sent?.length, code: error?.code };
});

await check('old-execution-cannot-borrow-new-decision', async () => {
  const world = makeWorld(); const first = seedDecision(world); const oldExecution = first.execution.executionId;
  world.ctx.invalidateActiveDecision(world.st, 'new-message');
  const second = seedDecision(world);
  let error = null; try { await world.ctx.sendMessagesV2('private:1', ['旧回合迟到'], [], null, null, { executionId: oldExecution, action: 'send_message' }); } catch (e) { error = e; }
  assert.equal(world.transports.length, 0);
  const ok = await world.ctx.sendMessagesV2('private:1', ['新回合'], [], null, null, { executionId: second.execution.executionId, action: 'send_message' });
  assert.equal(world.transports.length, 1);
  return { oldBlocked: !!error, newSent: ok.length };
});

await check('cross-scope-execution-rejected', async () => {
  const world = makeWorld(); const x = seedDecision(world);
  let error = null; try { await world.ctx.sendMessagesV2('group:2', ['跨会话'], [], null, null, { executionId: x.execution.executionId, action: 'send_message' }); } catch (e) { error = e; }
  assert.equal(world.transports.length, 0);
  return { error: error?.message };
});

await check('no-send-action-blocks-visible-media', async () => {
  const world = makeWorld();
  const d = mod.buildDecision({ key: 'private:1', snapshot: world.getSnapshot(), text: '不用回了', now, ttlMs: 360000 });
  const ex = execMod.createExecutionContext({ key: 'private:1', decision: d, sessionId: 'sess-1', epoch: 1, seq: 7, now, ttlMs: 360000 });
  world.st.activeDecision = d; world.st.activeDecisionSeq = 7; world.st.activeExecution = ex; world.st.activeExecutionId = ex.executionId; world.ctx.executionContexts.set(ex.executionId, ex);
  const actions = ['send_message', 'reply', 'poke', 'voice', 'sticker', 'image'];
  const codes = actions.map((action) => world.ctx.decisionSendGuard('private:1', action, ex.executionId).code);
  assert.ok(codes.every((c) => /not-allowed|missing/.test(c)));
  return { codes };
});

await check('provider-timeout-through-wake-path', async () => {
  let providerCalls = 0;
  const world = makeWorld({ provider: () => { providerCalls++; return new Promise(() => {}); } });
  world.st.unread = [{ seq: 7, messageId: 'm7', userId: '2', text: '这个怎么用？' }];
  const oldTimeout = world.ctx.cfg.socialV2.personalityV2.modelTimeoutMs; world.ctx.cfg.socialV2.personalityV2.modelTimeoutMs = 5;
  const r = await world.ctx.attachWakeDecision('private:1', 'at');
  assert.equal(providerCalls, 1);
  const decision = world.st.activeDecision;
  assert.ok(decision);
  return { providerCalls, decisionIntent: decision.intent, promptToken: world.st.activeExecutionId ? 'present' : 'missing' };
});

await check('recovered-decision-without-execution-zero', async () => {
  const world = makeWorld();
  world.st.activeDecision = mod.buildDecision({ key: 'private:1', snapshot: world.getSnapshot(), text: '这个怎么用？', now });
  world.st.activeDecisionSeq = 7; world.st.activeExecutionId = 'stale-from-disk';
  let error = null; try { await world.ctx.sendMessagesV2('private:1', ['恢复后旧决策'], [], null, null, { executionId: 'stale-from-disk', action: 'send_message' }); } catch (e) { error = e; }
  assert.equal(world.transports.length, 0); assert.match(error?.message || '', /执行凭证/);
  return { transports: world.transports.length, error: error?.message };
});
await check('turn-end-cancellation-zero', async () => {
  const world = makeWorld(); const x = seedDecision(world);
  world.ctx.cancelActiveExecution(world.st, 'turn-end');
  let error = null; try { await world.ctx.sendMessagesV2('private:1', ['回合结束'], [], null, null, { executionId: x.execution.executionId, action: 'send_message' }); } catch (e) { error = e; }
  assert.equal(world.transports.length, 0);
  return { transports: world.transports.length, error: error?.message };
});
await check('provider-result-discarded-if-turn-invalidated', async () => {
  const world = makeWorld({ provider: async ({ codeDecision }) => { await new Promise((r) => setTimeout(r, 10)); return { ...codeDecision, decisionId: 'late-provider', evidenceIds: ['m7'] }; } });
  world.st.unread = [{ seq: 7, messageId: 'm7', userId: '2', text: '这个怎么用？' }];
  const task = world.ctx.attachWakeDecision('private:1', 'at');
  await Promise.resolve();
  world.st.lastUnreadSeq = 8; world.ctx.invalidateActiveDecision(world.st, 'new-message');
  const result = await task;
  assert.equal(result, null); assert.equal(world.st.activeDecision, null);
  return { result, activeDecision: world.st.activeDecision };
});await check('provider-result-discarded-if-revision-changed', async () => {
  let world; world = makeWorld({ provider: ({ codeDecision }) => { world.setSnapshot({ ...world.getSnapshot(), revision: 4 }); return { ...codeDecision, decisionId: 'revision-race', evidenceIds: ['m7'] }; } });
  world.st.unread = [{ seq: 7, messageId: 'm7', userId: '2', text: '这个怎么用？' }];
  const result = await world.ctx.attachWakeDecision('private:1', 'at');
  assert.equal(result, null); assert.equal(world.st.activeDecision, null);
  return { result, activeDecision: world.st.activeDecision };
});
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-bridge-v2-results.json'), JSON.stringify(out, null, 2) + '\n');


