import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const m = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-execution.mjs')).href);
const now = Date.parse('2026-10-31T00:00:00.000Z');
const decision = (over = {}) => ({ decisionId: 'dec-1', intent: 'help', engagement: 'normal', reasonCodes: ['information'], evidenceIds: ['m1'], allowedActions: ['send_message', 'reply', 'poke', 'voice', 'sticker', 'image', 'wait', 'mark_read'], commitmentProposal: null, contextRevision: 3, expiresAt: new Date(now + 360000).toISOString(), ...over });
const results = [];
async function check(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }
function baseCtx(over = {}) { return m.createExecutionContext({ key: 'private:1', decision: decision(), sessionId: 'sess-1', epoch: 2, seq: 7, now, ttlMs: 360000, ...over }); }
function valid(ctx, over = {}) { return m.validateExecutionContext(ctx, { key: 'private:1', action: 'send_message', now, decision: decision(), activeExecutionId: ctx.executionId, currentEpoch: 2, lastUnreadSeq: 7, sessionId: 'sess-1', snapshotRevision: 3, ...over }); }

await check('valid-context-passes', () => { const c = baseCtx(); assert.equal(valid(c).ok, true); assert.match(c.executionId, /^[A-Za-z0-9_-]+$/); return c; });
await check('cross-scope-rejected', () => { const c = baseCtx(); const r = valid(c, { key: 'group:1' }); assert.equal(r.ok, false); assert.equal(r.code, 'execution-cross-scope'); return r; });
await check('expired-rejected', () => { const c = baseCtx(); const r = valid(c, { now: now + 400000 }); assert.equal(r.ok, false); assert.equal(r.code, 'execution-expired'); return r; });
await check('cancelled-rejected', () => { const c = baseCtx(); m.cancelExecutionContext(c, { now: now + 1, reason: 'new-message' }); const r = valid(c); assert.equal(r.ok, false); assert.equal(r.code, 'execution-cancelled'); return r; });
await check('replaced-epoch-rejected', () => { const c = baseCtx(); const r = valid(c, { activeExecutionId: 'other', currentEpoch: 3 }); assert.equal(r.ok, false); assert.match(r.code, /replaced|epoch/); return r; });
await check('stale-message-rejected', () => { const c = baseCtx(); const r = valid(c, { lastUnreadSeq: 8 }); assert.equal(r.ok, false); assert.equal(r.code, 'execution-stale-message'); return r; });
await check('session-change-rejected', () => { const c = baseCtx(); const r = valid(c, { sessionId: 'sess-2' }); assert.equal(r.ok, false); assert.equal(r.code, 'execution-session-changed'); return r; });
await check('revision-change-rejected', () => { const c = baseCtx(); const r = valid(c, { snapshotRevision: 4 }); assert.equal(r.ok, false); assert.equal(r.code, 'execution-stale-revision'); return r; });
await check('action-not-allowed-rejected', () => { const c = baseCtx({ decision: decision({ allowedActions: ['wait', 'mark_read', 'no_send'] }) }); const r = m.validateExecutionContext(c, { key: 'private:1', action: 'poke', now, decision: decision({ allowedActions: ['wait', 'mark_read', 'no_send'] }), activeExecutionId: c.executionId, currentEpoch: 2, lastUnreadSeq: 7, sessionId: 'sess-1', snapshotRevision: 3 }); assert.equal(r.ok, false); assert.equal(r.code, 'execution-action-not-allowed'); return r; });
await check('record-transport', () => { const c = baseCtx(); m.recordTransport(c, { action: 'poke', messageId: '42', now }); assert.equal(c.transported.length, 1); return c; });

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-execution-results.json'), JSON.stringify(out, null, 2) + '\n');
