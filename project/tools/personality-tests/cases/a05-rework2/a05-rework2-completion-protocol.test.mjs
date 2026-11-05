// A05-rework2 R1-F01/F02：完成回执协议、授权与真实 bridge 链。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const { commitmentsMod, execMod, makeWorld } = await import('./bridge-fixture.mjs');
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, 'a05r2-completion-'));
const db = storeMod.openMemory(path.join(tmp, 'memory.sqlite'));
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const base = Date.parse('2026-11-05T00:00:00.000Z');
let seq = 0;

function createActive({
  scope = 'private:22', targetId = '22', text = '我明天会阅读完整报告并写一份摘要',
  messageText = '这是阅读完整报告后写的摘要。', completionType = 'deliver_message',
} = {}) {
  seq += 1;
  const id = `c-${seq}`;
  const r = commitmentsMod.proposeCommitment({
    id, scope, actorId: 'self', targetId, text, messageText,
    dueAt: base + 86400000, source: 'decision', sourceRef: `dec-${id}`,
    decisionId: `dec-${id}`, requestRef: `message:req-${id}`, requestMessageId: `req-${id}`,
    executionId: `exec-${id}`, completionType,
    completionCondition: completionType === 'deliver_message' ? { messageText } : null,
    createdAt: base,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const activation = commitmentsMod.activateCommitment({
    id,
    evidence: {
      kind: 'send', success: true, ref: `send:${id}`, transportRef: `send:${id}`,
      messageId: `activation-${id}`, executionId: `exec-${id}`, decisionId: `dec-${id}`,
      messageText: '我明天会阅读完整报告并写一份摘要', at: base + 1,
    },
  });
  assert.equal(activation.ok, true, JSON.stringify(activation));
  return commitmentsMod.getCommitment({ id });
}

function bridgeWorld({ commitmentId, decisionId = 'new-decision' } = {}) {
  const world = makeWorld();
  world.st.activeDecision = {
    decisionId,
    intent: 'help',
    engagement: 'normal',
    reasonCodes: ['test'],
    evidenceIds: [],
    allowedActions: ['send_message', 'reply'],
    commitmentProposal: null,
    commitmentCompletion: commitmentId ? { commitmentId } : null,
    contextRevision: 3,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  return world;
}

async function sendInBridge(world, scope, messageText, { targetId = null, fail = false, messageId = 'ok' } = {}) {
  const [kind, id] = scope.split(':');
  if (fail) world.ctx.onebotSend = async () => { throw new Error('transport-down'); };
  else world.ctx.onebotSend = async () => ({ message_id: messageId });
  const decision = world.st.activeDecision;
  world.st.decisionEpoch = (Number(world.st.decisionEpoch) || 0) + 1;
  const execution = execMod.createExecutionContext({
    key: scope, decision, sessionId: null, epoch: world.st.decisionEpoch,
    seq: world.st.lastUnreadSeq, now: Date.now(), ttlMs: 3600000,
  });
  world.st.activeExecution = execution;
  world.st.activeExecutionId = execution.executionId;
  world.ctx.executionContexts.set(execution.executionId, execution);
  return world.ctx.sendMessagesV2(scope, [messageText], [], null, targetId, {
    executionId: execution.executionId, action: 'send_message',
  });
}

await test('ordinary-chat-does-not-fulfill-unspecified-task', async () => {
  const row = createActive({ completionType: 'unspecified', completionCondition: null });
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, row.scope, '我还没有读报告，稍后再说。');
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  assert.equal(after.fulfillment_ref, null);
  return { status: after.status };
});

await test('negative-completion-does-not-fulfill-deliver-message', async () => {
  const row = createActive();
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, row.scope, '我还没有读报告，稍后再说。');
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  return { status: after.status };
});

await test('oral-done-claim-without-artifact-does-not-fulfill', async () => {
  const row = createActive();
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, row.scope, '我完成了。');
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  return { status: after.status };
});

await test('quoting-task-only-does-not-fulfill', async () => {
  const row = createActive();
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, row.scope, `任务仍是：${row.text}`);
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  return { status: after.status };
});

await test('wrong-tool-does-not-fulfill', async () => {
  const row = createActive();
  const r = commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'notepad', action: 'send_message',
      resultRef: 'tool:wrong', commitmentId: row.id, scope: row.scope,
      actualTargetId: row.target_id, messageText: '这是阅读完整报告后写的摘要。', executionId: 'new-exec',
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'completion-action-mismatch');
  assert.equal(commitmentsMod.getCommitment({ id: row.id }).status, 'active');
  return { code: r.code };
});

await test('wrong-artifact-does-not-fulfill', async () => {
  const row = createActive();
  const r = commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: 'tool:wrong-artifact', commitmentId: row.id, scope: row.scope,
      actualTargetId: row.target_id, messageText: '别的文本', executionId: 'new-exec',
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'completion-artifact-mismatch');
  assert.equal(commitmentsMod.getCommitment({ id: row.id }).status, 'active');
  return { code: r.code };
});

await test('real-matching-transport-receipt-fulfills-once', async () => {
  const row = createActive();
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, row.scope, '这是阅读完整报告后写的摘要。', { messageId: 'deliver-1' });
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'fulfilled');
  assert.match(after.fulfillment_ref, /^qq:private:22:/);
  const again = commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: 'qq:private:22:new-exec:2:deliver-2', commitmentId: row.id,
      scope: row.scope, actualTargetId: row.target_id,
      messageText: '这是阅读完整报告后写的摘要。', executionId: 'new-exec-2',
    },
  });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'terminal-status');
  assert.equal(commitmentsMod.getCommitment({ id: row.id }).status, 'fulfilled');
  return { status: after.status, fulfillmentRef: after.fulfillment_ref, again: again.code };
});

await test('expired-or-duplicate-receipt-cannot-reopen-terminal', async () => {
  const row = createActive();
  commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: 'qq:private:22:exec:1:deliver', commitmentId: row.id, scope: row.scope,
      actualTargetId: row.target_id, messageText: '这是阅读完整报告后写的摘要。', executionId: 'exec',
    },
  });
  const r = commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: 'qq:private:22:old-exec:1:old', commitmentId: row.id, scope: row.scope,
      actualTargetId: row.target_id, messageText: '这是阅读完整报告后写的摘要。', executionId: 'old-exec',
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'terminal-status');
  return { code: r.code, status: commitmentsMod.getCommitment({ id: row.id }).status };
});

await test('cross-scope-send-cannot-fulfill-private-task', async () => {
  const row = createActive({ scope: 'private:22', targetId: '22' });
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, 'group:1', '这是阅读完整报告后写的摘要。');
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  assert.equal(after.fulfillment_ref, null);
  return { status: after.status };
});

await test('group-send-without-target-cannot-fulfill', async () => {
  const row = createActive({ scope: 'group:1', targetId: '22' });
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, 'group:1', '这是阅读完整报告后写的摘要。', { targetId: null });
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  return { status: after.status };
});

await test('wrong-target-cannot-fulfill', async () => {
  const row = createActive({ scope: 'group:1', targetId: '22' });
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, 'group:1', '这是阅读完整报告后写的摘要。', { targetId: '33' });
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  return { status: after.status };
});

await test('model-claimed-target-cannot-bypass-actual-target', async () => {
  const row = createActive({ scope: 'private:22', targetId: '22' });
  const world = bridgeWorld({ commitmentId: row.id });
  world.st.activeDecision.commitmentCompletion = { commitmentId: row.id, targetId: '22' };
  await sendInBridge(world, 'private:33', '这是阅读完整报告后写的摘要。');
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  return { status: after.status };
});

await test('old-execution-receipt-cannot-fulfill', async () => {
  const row = createActive();
  const before = JSON.stringify(row.evidence_json);
  const r = commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: row.send_ref, commitmentId: row.id, scope: row.scope,
      actualTargetId: row.target_id, messageText: '这是阅读完整报告后写的摘要。', executionId: `exec-${row.id}`,
    },
  });
  assert.equal(r.ok, false);
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'active');
  assert.equal(JSON.stringify(after.evidence_json), before);
  return { code: r.code };
});

await test('same-scope-same-target-normal-chain-only-once', async () => {
  const row = createActive();
  const world = bridgeWorld({ commitmentId: row.id });
  await sendInBridge(world, row.scope, '这是阅读完整报告后写的摘要。', { messageId: 'normal-1' });
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.status, 'fulfilled');
  const evidence = JSON.parse(after.evidence_json);
  assert.equal(evidence.filter((x) => x.kind === 'tool').length, 1);
  return { status: after.status, toolEvidence: evidence.filter((x) => x.kind === 'tool').length };
});

await test('atomic-transition-reports-zero-applied-on-race', async () => {
  const row = createActive();
  // 先手动占用状态，模拟并发获胜方。
  db.prepare("UPDATE commitments SET status='fulfilled', fulfillment_ref='winner' WHERE id=?").run(row.id);
  const current = commitmentsMod.getCommitment({ id: row.id });
  const loser = commitmentsMod.completeCommitment({
    id: row.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: 'loser-ref', commitmentId: row.id, scope: row.scope,
      actualTargetId: row.target_id, messageText: '这是阅读完整报告后写的摘要。', executionId: 'loser-exec',
    },
  });
  assert.equal(loser.ok, false);
  assert.equal(commitmentsMod.getCommitment({ id: row.id }).fulfillment_ref, 'winner');
  return { code: loser.code };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r2-completion-protocol-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
