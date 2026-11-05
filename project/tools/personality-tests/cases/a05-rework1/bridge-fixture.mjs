import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const execMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-execution.mjs')).href);
const commitmentsMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/commitments.mjs')).href);
function extract(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a); if (a < 0 || b < 0) throw new Error('marker missing: ' + start); return source.slice(a, b).trim(); }
const guardSrc = extract('function decisionSendGuard(', 'function cancelActiveExecution(');
const cancelSrc = extract('function cancelActiveExecution(', 'function invalidateActiveDecision(');
const invalidateSrc = extract('function invalidateActiveDecision(', 'function loadSocialV2State(');
const captureSrc = extract('function captureSendGuard(', '// 静默模式');
const sendSrc = extract('function sendMessagesV2(', '// 审计范围');
const attachSrc = extract('async function attachWakeDecision(', 'function decisionSendGuard(');
const providerSrc = extract('async function callDecisionProvider(', 'async function attachWakeDecision(');
const commitmentSrc = extract('function commitmentRequestFromRecent(', 'function stateUnavailableDecision(');
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
    proposeCommitment: commitmentsMod.proposeCommitment,
    listCommitments: commitmentsMod.listCommitments,
    activateCommitmentsForSendReceipt: commitmentsMod.activateCommitmentsForSendReceipt,
    completeCommitmentFromToolResult: commitmentsMod.completeCommitmentFromToolResult,
  });
  ctx.sendChain = Promise.resolve();
  if (provider) ctx.__A03_DECISION_PROVIDER__ = provider;
  vm.runInContext(guardSrc + '\n' + cancelSrc + '\n' + invalidateSrc + '\n' + captureSrc + '\n' + providerSrc + '\n' + attachSrc + '\n' + commitmentSrc + '\n' + sendSrc, ctx);
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

export { C, source, mod, execMod, commitmentsMod, extract, now, snapshotBase, makeWorld, seedDecision };

