const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
const { createTurnCollector } = await import(pathToFileURL(path.join(CANDIDATE_ROOT, 'qq-bridge/src/dsh-client.js')).href);
// A03-rework2 R01：真实 trackTurnEvent/cancelTurnExecution 与 turnId 归属。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { makeWorld, seedDecision, extract } from './bridge-fixture.mjs';

const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
const source = fs.readFileSync(path.join(CANDIDATE_ROOT, 'qq-bridge/src/bridge.js'), 'utf8');
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (error) { results.push({ id, ok: false, error: String(error?.stack ?? error) }); }
}
function harness() {
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
  });
  const src = extract('function bindTurnExecution(', 'async function pumpMux(');
  vm.runInContext(src, w.ctx);
  return { w, turnExecutionMap, collectors };
}

test('current-turn-end-cancels-current-execution', () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  h.w.ctx.noteTurnDispatch('sess-1', execution.executionId);
  const before = h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId);
  assert.equal(before.ok, true);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/start', data: { turn: 't-current' } });
  assert.equal(h.turnExecutionMap.get('sess-1:t-current'), execution.executionId);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/end', data: { turn: 't-current', reason: { kind: 'completed' } } });
  const after = h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId);
  assert.equal(after.ok, false);
  return { before: before.ok, after: after.ok, code: after.code };
});

test('late-old-turn-end-does-not-cancel-new-execution', () => {
  const h = harness();
  const { execution: old } = seedDecision(h.w);
  h.w.ctx.noteTurnDispatch('sess-1', old.executionId);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/start', data: { turn: 't-old' } });
  // 模拟 attach 替换：旧执行取消并清理旧 turn 映射，再签发新执行。
  h.turnExecutionMap.delete('sess-1:t-old');
  h.w.ctx.cancelActiveExecution(h.w.st, 'decision-replaced');
  const { execution: current } = seedDecision(h.w);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/end', data: { turn: 't-old', reason: { kind: 'completed' } } });
  const after = h.w.ctx.decisionSendGuard('private:1', 'send_message', current.executionId);
  assert.equal(after.ok, true);
  assert.notEqual(old.executionId, current.executionId);
  return { after: after.ok, old: old.executionId.slice(0, 6), current: current.executionId.slice(0, 6) };
});

test('unmatched-end-without-start-does-not-cancel', () => {
  const h = harness();
  const { execution } = seedDecision(h.w);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/end', data: { turn: 't-unknown', reason: { kind: 'completed' } } });
  const after = h.w.ctx.decisionSendGuard('private:1', 'send_message', execution.executionId);
  assert.equal(after.ok, true);
  return { after: after.ok };
});

test('second-turn-end-does-not-cancel-replaced-execution', () => {
  const h = harness();
  const { execution: first } = seedDecision(h.w);
  h.w.ctx.noteTurnDispatch('sess-1', first.executionId);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/start', data: { turn: 't-first' } });
  h.turnExecutionMap.delete('sess-1:t-first');
  h.w.ctx.cancelActiveExecution(h.w.st, 'replaced');
  const { execution: second } = seedDecision(h.w);
  h.w.ctx.trackTurnEvent('sess-1', { type: 'turn/end', data: { turn: 't-first', reason: { kind: 'completed' } } });
  const after = h.w.ctx.decisionSendGuard('private:1', 'send_message', second.executionId);
  assert.equal(after.ok, true);
  assert.notEqual(first.executionId, second.executionId);
  return { after: after.ok };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-r01-turn-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
