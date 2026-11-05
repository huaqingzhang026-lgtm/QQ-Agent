import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const em = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-execution.mjs')).href);
function extract(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a); if (a < 0 || b < 0) throw new Error('marker missing'); return source.slice(a, b).trim(); }
const guardSrc = extract('function decisionSendGuard(', 'function cancelActiveExecution(');
const captureSrc = extract('function captureSendGuard(', '// 静默模式');
const routeSrc = extract("if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke')", '        // ── 表情包体系');
const now = Date.parse('2026-10-31T00:00:00.000Z');
const snapshot = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [] } };

function world(decision, { invalidateDuringMember = false } = {}) {
  const calls = [];
  const responses = [];
  const st = { lastUnreadSeq: 7, activeDecisionSeq: 7, decisionEpoch: 1, activeDecision: decision, activeExecution: null, activeExecutionId: '', sendTimes: [], recentMessages: [], wakeConfig: {} };
  const ex = em.createExecutionContext({ key: 'group:2', decision, sessionId: 'sess-1', epoch: 1, seq: 7, now, ttlMs: 360000 });
  st.activeExecution = ex; st.activeExecutionId = ex.executionId;
  const executionContexts = new Map([[ex.executionId, ex]]);
  const ctx = vm.createContext({
    currentMode: 'reserved2', cfg: { socialV2: { send: {}, context: {} } }, Date: class extends Date { static now(){ return now; } }, Number, path, personalityEnabled: () => true,
    req: { method: 'POST', headers: { 'x-agent-token': 'tok' } }, url: { pathname: '/api/socialV2/send-poke' },
    readBody: async () => ({ key: 'group:2', targetUserId: '3', executionId: ex.executionId }),
    sendJson: (body, status) => responses.push({ body, status: status ?? 200 }),
    agentTokenOk: () => true, v2SessionAllowed: () => true, v2ToolEnabled: () => true,
    socialV2: { paused: false }, modeAllowed: () => true, shouldBlockSilentReply: () => false,
    executionContexts, getSocialV2State: () => st,
    getPersonalityStore: () => ({ loadSnapshot: () => ({ ok: true, snapshot }) }),
    isDecisionUsable: mod.isDecisionUsable, actionAllowed: mod.actionAllowed,
    validateExecutionContext: em.validateExecutionContext,
    sessionPolicy: () => 'p', isSessionAllowedInCurrentMode: () => true,
    state: { sessions: { 'group:2': 'sess-1' } },
    saveSocialV2State: () => {}, appendActivity: () => {}, log: () => {},
    bot: { raw: async (...args) => { calls.push(args); return { ok: true }; } },
    assertGroupMember: async () => { if (invalidateDuringMember) { st.activeExecution.cancelledAt = now; st.activeExecution.cancelReason = 'new-message'; st.decisionEpoch++; } return null; },
  });
  vm.runInContext(guardSrc + '\n' + captureSrc, ctx);
  return { ctx, st, calls, responses, ex };
}
const results = [];
async function check(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

await check('poke-valid-send-once', async () => {
  const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now });
  const w = world(d);
  await vm.runInContext('(async function(){' + routeSrc + '})()', w.ctx);
  assert.equal(w.calls.length, 1, JSON.stringify(w.responses)); assert.equal(w.responses[0]?.body?.ok, true);
  return { calls: w.calls.length, response: w.responses[0] };
});
await check('poke-no-send-disengage-zero', async () => {
  const d = mod.buildDecision({ key: 'group:2', snapshot, text: '不用回了', now });
  const w = world(d);
  await vm.runInContext('(async function(){' + routeSrc + '})()', w.ctx);
  assert.equal(w.calls.length, 0); assert.equal(w.responses[0]?.status, 409);
  return { calls: w.calls.length, response: w.responses[0] };
});
await check('poke-invalidated-during-member-check-zero', async () => {
  const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now });
  const w = world(d, { invalidateDuringMember: true });
  await vm.runInContext('(async function(){' + routeSrc + '})()', w.ctx);
  assert.equal(w.calls.length, 0); assert.equal(w.responses[0]?.status, 409);
  return { calls: w.calls.length, response: w.responses[0] };
});
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-poke-results.json'), JSON.stringify(out, null, 2) + '\n');





