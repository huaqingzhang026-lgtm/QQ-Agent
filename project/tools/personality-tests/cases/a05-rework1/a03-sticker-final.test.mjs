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
const stickerSrc = extract('async function sendStickerV2(', '  // 更新本地 AI 认知');
const now = Date.parse('2026-10-31T00:00:00.000Z');
const snapshot = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [] } };
function world(decision, { invalidateDuringSleep = false, revisionChange = false } = {}) {
  const calls = [];
  const st = { lastUnreadSeq: 7, activeDecisionSeq: 7, decisionEpoch: 1, activeDecision: decision, activeExecution: null, activeExecutionId: '', sendTimes: [] };
  const ex = em.createExecutionContext({ key: 'group:2', decision, sessionId: 'sess-1', epoch: 1, seq: 7, now, ttlMs: 360000 });
  st.activeExecution = ex; st.activeExecutionId = ex.executionId;
  const ctx = vm.createContext({
    currentMode: 'reserved2', cfg: { socialV2: { sticker: { enabled: true } } }, AbortSignal: { timeout: () => null }, Date: class extends Date { static now(){ return now; } }, MAX_MEDIA_BYTES: 1000000,
    executionContexts: new Map([[ex.executionId, ex]]), getSocialV2State: () => st,
    getPersonalityStore: () => ({ loadSnapshot: () => ({ ok: true, snapshot: revisionChange ? { ...snapshot, revision: 4 } : snapshot }) }),
    personalityEnabled: () => true, isDecisionUsable: mod.isDecisionUsable, actionAllowed: mod.actionAllowed,
    validateExecutionContext: em.validateExecutionContext, sessionPolicy: () => 'p', isSessionAllowedInCurrentMode: () => true,
    state: { sessions: { 'group:2': 'sess-1' } }, saveSocialV2State: () => {},
    sendChain: Promise.resolve(), sleep: async () => { if (invalidateDuringSleep) { ex.cancelledAt = now; ex.cancelReason = 'new-message'; st.decisionEpoch++; } }, randInt: () => 1,
    stickerEntries: [], syncStickerLibrary: async () => ({ entries: [{ id: 's1', url: 'http://example.invalid/a.png', desc: '表情' }] }),
    findSticker: () => ({ id: 's1', url: 'http://example.invalid/a.png', desc: '表情' }),
    safeFetchBuffer: async () => ({ buffer: Buffer.from([1, 2, 3]) }),
    markStickerUsed: () => ({ entries: [], entry: { id: 's1' } }), saveStickerStoreSafe: () => {},
    fetch: async (...args) => { calls.push(args); return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: '42' } }) }; },
    log: () => {},
  });
  vm.runInContext(guardSrc + '\n' + captureSrc + '\n' + stickerSrc, ctx);
  return { ctx, st, calls };
}
const results = [];
async function check(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }
await check('sticker-valid-final-transport', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now }); const w = world(d); const r = await w.ctx.sendStickerV2('group:2', 's1', { executionId: w.st.activeExecutionId }); assert.equal(r.messageId, '42'); assert.equal(w.calls.length, 1); return { messageId: r.messageId, calls: w.calls.length }; });
await check('sticker-no-send-disengage-zero', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '不用回了', now }); const w = world(d); let e = null; try { await w.ctx.sendStickerV2('group:2', 's1', { executionId: w.st.activeExecutionId }); } catch (err) { e = err; } assert.equal(w.calls.length, 0); return { calls: w.calls.length, error: e?.message }; });
await check('sticker-invalidation-during-sleep-zero', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now }); const w = world(d, { invalidateDuringSleep: true }); let e = null; try { await w.ctx.sendStickerV2('group:2', 's1', { executionId: w.st.activeExecutionId }); } catch (err) { e = err; } assert.equal(w.calls.length, 0); return { calls: w.calls.length, error: e?.message }; });
await check('sticker-revision-change-zero', async () => { const d = mod.buildDecision({ key: 'group:2', snapshot, text: '这个怎么用？', now }); const w = world(d, { revisionChange: true }); let e = null; try { await w.ctx.sendStickerV2('group:2', 's1', { executionId: w.st.activeExecutionId }); } catch (err) { e = err; } assert.equal(w.calls.length, 0); return { calls: w.calls.length, error: e?.message }; });
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-sticker-results.json'), JSON.stringify(out, null, 2) + '\n');

