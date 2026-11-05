import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const em = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-execution.mjs')).href);
function extract(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a); if (a < 0 || b < 0) throw new Error('marker missing: ' + start); return source.slice(a, b).trim(); }
const guardSrc = extract('function decisionSendGuard(', 'function cancelActiveExecution(');
const captureSrc = extract('function captureSendGuard(', '// 静默模式');
const voiceSrc = extract('async function sendVoiceV2(', '// 发送一个收藏表情');
const now = Date.parse('2026-10-31T00:00:00.000Z');
const snapshot = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [] } };
function world(decision, { invalidateDuringAudio = false } = {}) {
  const sends = [];
  const st = { lastUnreadSeq: 7, activeDecisionSeq: 7, decisionEpoch: 1, activeDecision: decision, activeExecution: null, activeExecutionId: '' };
  const ex = em.createExecutionContext({ key: 'group:2', decision, sessionId: 'sess-1', epoch: 1, seq: 7, now, ttlMs: 360000 });
  st.activeExecution = ex; st.activeExecutionId = ex.executionId;
  const ctx = vm.createContext({
    currentMode: 'reserved2', cfg: { socialV2: { voice: {} } }, sendChain: Promise.resolve(), Date: class extends Date { static now(){ return now; } }, AbortSignal: { timeout: () => null }, path,
    executionContexts: new Map([[ex.executionId, ex]]), getSocialV2State: () => st,
    getPersonalityStore: () => ({ loadSnapshot: () => ({ ok: true, snapshot }) }), personalityEnabled: () => true,
    isDecisionUsable: mod.isDecisionUsable, actionAllowed: mod.actionAllowed, validateExecutionContext: em.validateExecutionContext,
    sessionPolicy: () => 'p', isSessionAllowedInCurrentMode: () => true, state: { sessions: { 'group:2': 'sess-1' } }, saveSocialV2State: () => {}, log: () => {},
    voiceCfg: () => ({ enabled: true, maxBytes: 1000000, maxSeconds: 60, defaultVolume: 1, loudness: false }), describeAudio: () => 'ok', cleanupTemp: () => {}, assertOutboundAuditOk: () => {},
    inspectAudio: async () => ({ ok: true, size: 3, duration: 1 }), processAudioVolume: async (p) => { if (invalidateDuringAudio) { ex.cancelledAt = now; ex.cancelReason = 'new-message'; st.decisionEpoch++; } return { path: p }; },
    outboundGateway: { submit: async ({ send }) => { const result = await send(); return { state: 'sent', result }; } },
    postOneBot: async (...args) => { sends.push(args); return {}; },
  });
  vm.runInContext(guardSrc + '\n' + captureSrc + '\n' + voiceSrc, ctx);
  return { ctx, st, sends };
}
const results = [];
async function check(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }
await check('voice-valid-final-transport', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now }); const w = world(d); const r = await w.ctx.sendVoiceV2('group:2', 'x.mp3', { guard: true, audit: false, executionId: w.st.activeExecutionId, action: 'voice' }); assert.equal(w.sends.length, 1); return { messageId: r.messageId, sends: w.sends.length }; });
await check('voice-no-send-disengage-zero', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '不用回了', now }); const w = world(d); let e = null; try { await w.ctx.sendVoiceV2('group:2', 'x.mp3', { guard: true, audit: false, executionId: w.st.activeExecutionId, action: 'voice' }); } catch (err) { e = err; } assert.equal(w.sends.length, 0); return { sends: w.sends.length, error: e?.message }; });
await check('voice-invalidated-during-audio-zero', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now }); const w = world(d, { invalidateDuringAudio: true }); let e = null; try { await w.ctx.sendVoiceV2('group:2', 'x.mp3', { guard: true, audit: false, executionId: w.st.activeExecutionId, action: 'voice' }); } catch (err) { e = err; } assert.equal(w.sends.length, 0); return { sends: w.sends.length, error: e?.message }; });
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-voice-results.json'), JSON.stringify(out, null, 2) + '\n');



