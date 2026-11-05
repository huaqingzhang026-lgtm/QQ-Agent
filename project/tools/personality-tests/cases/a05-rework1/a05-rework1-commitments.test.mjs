// A05-rework1 F02/F03/F04：承诺状态机、证据校验、身份去重与生产回执链。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const cmt = await import(pathToFileURL(path.join(C, 'qq-bridge/src/commitments.mjs')).href);
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, 'a05r1-commitments-'));
const db = storeMod.openMemory(path.join(tmp, 'memory.sqlite'));
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const base = Date.parse('2026-11-05T00:00:00.000Z');

function proposal(id, over = {}) {
  return cmt.proposeCommitment({
    id,
    scope: 'group:1',
    actorId: 'self',
    targetId: '22',
    text: '我明天帮你整理面试资料',
    messageText: '我明天帮你整理面试资料，整理好就发你。',
    dueAt: base + 86400000,
    source: 'decision',
    sourceRef: `dec-${id}`,
    decisionId: `dec-${id}`,
    requestRef: `message:req-${id}`,
    requestMessageId: `req-${id}`,
    executionId: `exec-${id}`,
    createdAt: base,
    ...over,
  });
}
function sendEvidence(id, over = {}) {
  return {
    kind: 'send', success: true, ref: `send:${id}`, transportRef: `send:${id}`,
    messageId: `msg-${id}`, executionId: `exec-${id}`, decisionId: `dec-${id}`,
    messageText: '我明天帮你整理面试资料，整理好就发你。', at: base + 1000, ...over,
  };
}
function toolEvidence(id, over = {}) {
  return {
    kind: 'tool', success: true, toolName: 'file-organizer', action: 'organize',
    resultRef: `tool:${id}`, commitmentId: id, targetId: '22',
    decisionId: `dec-${id}`, executionId: `exec-${id}`, at: base + 2000, ...over,
  };
}

test('activation-rejects-missing-or-non-send-evidence', () => {
  const p = proposal('no-evidence').commitment;
  const none = cmt.activateCommitment({ id: p.id, evidence: null });
  const wrongKind = cmt.activateCommitment({ id: p.id, evidence: { kind: 'request', success: true, ref: 'x', messageId: 'y', executionId: 'z' } });
  const failed = cmt.activateCommitment({ id: p.id, evidence: sendEvidence(p.id, { success: false }) });
  assert.equal(none.ok, false);
  assert.equal(wrongKind.ok, false);
  assert.equal(failed.ok, false);
  const row = cmt.getCommitment({ id: p.id });
  assert.equal(row.status, 'proposed');
  return { none: none.code, wrongKind: wrongKind.code, failed: failed.code, status: row.status };
});

test('send-receipt-must-match-decision-execution-and-full-message', () => {
  const p = proposal('receipt-match').commitment;
  const wrongExec = cmt.activateCommitment({ id: p.id, evidence: sendEvidence(p.id, { executionId: 'other-exec' }) });
  const wrongDecision = cmt.activateCommitment({ id: p.id, evidence: sendEvidence(p.id, { decisionId: 'other-dec' }) });
  const wrongText = cmt.activateCommitmentsForSendReceipt({
    scope: 'group:1', decision: { decisionId: p.decision_id }, executionId: `exec-${p.id}`,
    messageId: 'msg-x', transportRef: 'send:x', messageText: '我不能答应这件事。', success: true,
  });
  const ok = cmt.activateCommitmentsForSendReceipt({
    scope: 'group:1', decision: { decisionId: p.decision_id }, executionId: `exec-${p.id}`,
    messageId: `msg-${p.id}`, transportRef: `send:${p.id}`, messageText: sendEvidence(p.id).messageText, success: true,
  });
  assert.equal(wrongExec.ok, false);
  assert.equal(wrongDecision.ok, false);
  assert.equal(wrongText.activated, 0);
  assert.equal(ok.activated, 1);
  const row = cmt.getCommitment({ id: p.id });
  assert.equal(row.status, 'active');
  assert.equal(row.send_ref, `send:${p.id}`);
  return { wrongExec: wrongExec.code, wrongDecision: wrongDecision.code, wrongText: wrongText.activated, status: row.status };
});

test('completion-requires-active-and-new-tool-evidence', () => {
  const proposed = proposal('complete-before-active').commitment;
  const beforeActive = cmt.completeCommitment({ id: proposed.id, evidence: toolEvidence(proposed.id) });
  assert.equal(beforeActive.ok, false);
  cmt.activateCommitment({ id: proposed.id, evidence: sendEvidence(proposed.id) });
  const reusedRequest = cmt.completeCommitment({ id: proposed.id, evidence: toolEvidence(proposed.id, { resultRef: `message:req-${proposed.id}` }) });
  const reusedSend = cmt.completeCommitment({ id: proposed.id, evidence: toolEvidence(proposed.id, { resultRef: `send:${proposed.id}` }) });
  const noTool = cmt.completeCommitment({ id: proposed.id, evidence: { kind: 'model-said-done', success: true, resultRef: 'model:1' } });
  const ok = cmt.completeCommitment({ id: proposed.id, evidence: toolEvidence(proposed.id) });
  assert.equal(reusedRequest.ok, false);
  assert.equal(reusedSend.ok, false);
  assert.equal(noTool.ok, false);
  assert.equal(ok.ok, true);
  assert.equal(ok.commitment.status, 'fulfilled');
  const again = cmt.completeCommitment({ id: proposed.id, evidence: toolEvidence(proposed.id, { resultRef: 'tool:another' }) });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'terminal-status');
  return { beforeActive: beforeActive.code, reusedRequest: reusedRequest.code, reusedSend: reusedSend.code, noTool: noTool.code, status: ok.commitment.status, again: again.code };
});

test('terminal-status-cannot-become-another-terminal', () => {
  const fulfilled = proposal('terminal-fulfilled').commitment;
  cmt.activateCommitment({ id: fulfilled.id, evidence: sendEvidence(fulfilled.id) });
  cmt.completeCommitment({ id: fulfilled.id, evidence: toolEvidence(fulfilled.id) });
  assert.equal(cmt.withdrawCommitment({ id: fulfilled.id }).ok, false);
  const withdrawn = proposal('terminal-withdrawn').commitment;
  cmt.withdrawCommitment({ id: withdrawn.id });
  assert.equal(cmt.activateCommitment({ id: withdrawn.id, evidence: sendEvidence(withdrawn.id) }).ok, false);
  return { fulfilled: 'fulfilled', withdrawn: 'withdrawn' };
});

test('unknown-transport-does-not-activate', () => {
  const p = proposal('unknown-transport').commitment;
  const missingReceipt = cmt.activateCommitmentsForSendReceipt({
    scope: 'group:1', decision: { decisionId: p.decision_id }, executionId: `exec-${p.id}`,
    messageId: null, transportRef: null, messageText: p.message_text, success: true,
  });
  assert.equal(missingReceipt.activated, 0);
  const row = cmt.getCommitment({ id: p.id });
  assert.equal(row.status, 'proposed');
  return { activated: missingReceipt.activated, status: row.status };
});

test('partial-send-only-activates-exact-message', () => {
  const first = proposal('partial-first').commitment;
  const second = proposal('partial-second', {
    text: '我明天帮你整理第二份资料',
    messageText: '第二份资料已经整理好，明天发你。',
    decisionId: 'dec-partial-second',
    requestRef: 'message:req-partial-second',
    requestMessageId: 'req-partial-second',
    sourceRef: 'dec-partial-second',
  }).commitment;
  const onlyFirst = cmt.activateCommitmentsForSendReceipt({
    scope: 'group:1', decision: { decisionId: first.decision_id }, executionId: `exec-${first.id}`,
    messageId: 'msg-first', transportRef: 'send:first', messageText: first.message_text, success: true,
  });
  assert.equal(onlyFirst.activated, 1);
  assert.equal(cmt.getCommitment({ id: second.id }).status, 'proposed');
  return { first: cmt.getCommitment({ id: first.id }).status, second: cmt.getCommitment({ id: second.id }).status };
});

test('identity-distinguishes-actor-target-due-and-request', () => {
  const a = proposal('identity-a').commitment;
  const b = proposal('identity-b', {
    actorId: 'self', targetId: '33', dueAt: base + 2 * 86400000,
    text: '我明天帮你整理面试资料', messageText: '我明天帮你整理面试资料，整理好就发你。',
    decisionId: 'dec-identity-b', requestRef: 'message:req-identity-b', requestMessageId: 'req-identity-b',
    sourceRef: 'dec-identity-b',
  }).commitment;
  assert.notEqual(a.identity, b.identity);
  assert.equal(b.status, 'proposed');
  const retry = proposal('identity-a-retry', {
    requestRef: 'message:req-identity-a', requestMessageId: 'req-identity-a',
  }).commitment;
  assert.equal(retry.id, a.id);
  assert.equal(cmt.getCommitment({ id: b.id }).target_id, '33');
  return { a: a.id, b: b.id, retry: retry.id };
});

test('finished-record-does-not-block-new-request', () => {
  const oldOne = proposal('finished-old').commitment;
  cmt.activateCommitment({ id: oldOne.id, evidence: sendEvidence(oldOne.id) });
  cmt.completeCommitment({ id: oldOne.id, evidence: toolEvidence(oldOne.id) });
  const newOne = proposal('finished-new', {
    decisionId: 'dec-finished-new', requestRef: 'message:req-finished-new', requestMessageId: 'req-finished-new', sourceRef: 'dec-finished-new',
  }).commitment;
  assert.equal(newOne.status, 'proposed');
  assert.equal(newOne.status, 'proposed');
  return { oldStatus: 'fulfilled', newId: newOne.id };
});

test('withdraw-reschedule-and-expire-persist', () => {
  const active = proposal('lifecycle-active').commitment;
  cmt.activateCommitment({ id: active.id, evidence: sendEvidence(active.id) });
  const rescheduled = cmt.rescheduleCommitment({ id: active.id, dueAt: base + 3 * 86400000, reason: 'user-asked' });
  assert.equal(rescheduled.applied, true);
  const withdrawn = cmt.withdrawCommitment({ id: active.id, reason: 'user-cancelled' });
  assert.equal(withdrawn.applied, true);
  const expired = proposal('lifecycle-expired', { dueAt: base - 1000 }).commitment;
  const result = cmt.expireCommitments({ now: base + 1000 });
  assert.ok(result.expired >= 1);
  assert.equal(cmt.getCommitment({ id: expired.id }).status, 'expired');
  assert.equal(cmt.getCommitment({ id: withdrawn.commitment.id }).status, 'withdrawn');
  return { rescheduled: rescheduled.commitment.due_at, withdrawn: withdrawn.commitment.status, expired: cmt.getCommitment({ id: expired.id }).status };
});

test('wrong-id-and-wrong-target-rejected', () => {
  const p = proposal('wrong-target').commitment;
  cmt.activateCommitment({ id: p.id, evidence: sendEvidence(p.id) });
  const wrongId = cmt.completeCommitmentFromToolResult({ commitmentId: 'does-not-exist', toolName: 'file-organizer', action: 'organize', resultRef: `tool:${p.id}`, success: true });
  const wrongTarget = cmt.completeCommitment({ id: p.id, evidence: toolEvidence(p.id, { targetId: '99' }) });
  assert.equal(wrongId.ok, false);
  assert.equal(wrongTarget.ok, false);
  return { wrongId: wrongId.code, wrongTarget: wrongTarget.code };
});

test('records-persist-across-direct-reopen', () => {
  const p = proposal('restart-persist').commitment;
  cmt.activateCommitment({ id: p.id, evidence: sendEvidence(p.id) });
  const raw = new DatabaseSync(path.join(tmp, 'memory.sqlite'));
  const row = raw.prepare('SELECT status,send_ref FROM commitments WHERE id=?').get(p.id);
  raw.close();
  assert.equal(row.status, 'active');
  assert.equal(row.send_ref, `send:${p.id}`);
  return row;
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r1-commitments-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
