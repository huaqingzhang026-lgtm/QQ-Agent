const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
const { createTurnCollector } = await import(pathToFileURL(path.join(CANDIDATE_ROOT, 'qq-bridge/src/dsh-client.js')).href);
// A03-rework3 H01：真实 bindTurnExecution/trackTurnEvent/cancelTurnExecution 的 turn 归属。
// 绑定只认“真实投递登记”的 FIFO，不凭“当前有 pending execution”认领任意 start。
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
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (error) { results.push({ id, ok: false, error: String(error?.stack ?? error) }); }
}
function harness() {
  const w = makeWorld();
  w.st.unread = Array.isArray(w.st.unread) ? w.st.unread : [];
  const turnExecutionMap = new Map();
  const collectors = new Map();
  const v2TurnStartAt = new Map();
  const turnLeaseNoted = new Set();
  Object.assign(w.ctx, {
    turnExecutionMap, collectors, v2TurnStartAt, turnLeaseNoted,
    reverse: new Map([['sess-1', 'private:1']]),
    createTurnCollector,
    saveSocialV2State: () => {},
  });
  vm.runInContext(extract('function bindTurnExecution(', 'async function pumpMux('), w.ctx);
  return { w, turnExecutionMap, collectors };
}
function start(h, turn) { return h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/start', data: { turn } }); }
function end(h, turn) { return h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }); }

test('valid-dispatch-binds-current-turn-and-end-cancels', () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  h.w.ctx.noteTurnDispatch('sess-1', execution.executionId);
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId).ok, true);
  start(h, 't-current');
  assert.equal(h.turnExecutionMap.get('sess-1:t-current'), execution.executionId);
  assert.equal(execution.turnId, 't-current');
  assert.equal(execution.turnBound, true);
  end(h, 't-current');
  const after = h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId);
  assert.equal(after.ok, false);
  return { bound: true, after: after.ok, code: after.code };
});

test('replayed-old-start-does-not-bind-new-execution', () => {
  const h = harness();
  const old = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', old.executionId);
  start(h, 't-old'); end(h, 't-old');
  const current = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', current.executionId);
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId).ok, true);
  start(h, 't-old');
  assert.equal(current.turnId.startsWith('pending-'), true);
  assert.notEqual(current.turnId, 't-old');
  end(h, 't-old');
  const afterOld = h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId);
  assert.equal(afterOld.ok, true);
  start(h, 't-new');
  assert.equal(current.turnId, 't-new');
  end(h, 't-new');
  const afterNew = h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId);
  assert.equal(afterNew.ok, false);
  return { afterOld: afterOld.ok, afterNew: afterNew.ok, newTurn: current.turnId };
});

test('unregistered-start-does-not-claim-pending-execution', () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  start(h, 't-rogue');
  assert.equal(h.turnExecutionMap.has('sess-1:t-rogue'), false);
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId).ok, true);
  end(h, 't-rogue');
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId).ok, true);
  return { bound: false, stillAllowed: true };
});

test('unknown-end-does-not-cancel-current', () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  end(h, 't-unknown');
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId).ok, true);
  return { allowed: true };
});

test('late-old-end-does-not-cancel-replaced-execution', () => {
  const h = harness();
  const old = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', old.executionId);
  start(h, 't-old');
  h.w.ctx.cancelActiveExecution(h.w.st, 'decision-replaced');
  const current = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', current.executionId);
  end(h, 't-old');
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId).ok, true);
  return { allowed: true };
});

test('duplicate-end-is-idempotent', () => {
  const h = harness();
  const first = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', first.executionId);
  start(h, 't-1'); end(h, 't-1');
  const current = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', current.executionId);
  end(h, 't-1');
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId).ok, true);
  return { allowed: true };
});

test('expired-dispatch-does-not-bind-late-start', () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  h.w.ctx.noteTurnDispatch('sess-1', execution.executionId);
  h.w.setClock(now + 6 * 60 * 1000);
  start(h, 't-late');
  assert.equal(h.turnExecutionMap.has('sess-1:t-late'), false);
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId).ok, false);
  return { bound: false, note: 'execution itself is also expired; the key assertion is no late binding' };
});

test('two-dispatched-turns-bind-in-fifo-order', () => {
  const h = harness();
  const first = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', first.executionId);
  start(h, 't-a');
  assert.equal(h.turnExecutionMap.get('sess-1:t-a'), first.executionId);
  end(h, 't-a');
  const second = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', second.executionId);
  start(h, 't-b');
  assert.equal(h.turnExecutionMap.get('sess-1:t-b'), second.executionId);
  end(h, 't-b');
  return { a: first.executionId.slice(0, 6), b: second.executionId.slice(0, 6) };
});

test('cancelled-dispatch-start-does-not-revive-new-execution', () => {
  const h = harness();
  const old = seedDecision(h.w).execution;
  h.w.ctx.noteTurnDispatch('sess-1', old.executionId);
  h.w.ctx.cancelActiveExecution(h.w.st, 'new-message');
  const current = seedDecision(h.w).execution;
  start(h, 't-old');
  assert.equal(h.turnExecutionMap.get('sess-1:t-old'), old.executionId);
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId).ok, true);
  end(h, 't-old');
  assert.equal(h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId).ok, true);
  return { mappedToOld: true, currentStillAllowed: true };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-h01-turn-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
