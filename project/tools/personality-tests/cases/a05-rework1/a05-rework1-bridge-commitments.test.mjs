// A05-rework1 F02：真实 bridge decision→proposal→transport receipt→active/fulfilled 链。
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
const tmp = fs.mkdtempSync(path.join(root, 'a05r1-bridge-'));
const db = storeMod.openMemory(path.join(tmp, 'memory.sqlite'));
const results = [];
let logs = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const base = Date.parse('2026-11-05T00:00:00.000Z');
const roleEvidence = {
  authorId: '22', targets: ['99'], signals: [{ source: 'fixture', target: '99' }],
  replyTarget: null, hasReply: false, replyUnknown: false, systemId: '99',
  scopeType: 'group', conflict: false, sources: ['fixture'], eligibility: 'eligible', code: 'ok',
};

function seedInbound(world, messageId = 'm7', text = '明天记得把资料发我。') {
  const msg = { seq: 7, messageId, userId: '22', sender: 'A', text, plain: text, isSelf: false, roleEvidence };
  world.st.unread = [msg];
  world.st.recentMessages = [msg];
  return msg;
}

let bridgeCaseSeq = 0;
function nextEvidenceId() { bridgeCaseSeq += 1; return `m-${bridgeCaseSeq}`; }
function providerDecision(messageText, evidenceId = 'm7', over = {}) {
  return ({ codeDecision }) => ({
    ...codeDecision,
    decisionId: 'model-dec-commitment',
    evidenceIds: [evidenceId],
    allowedActions: ['send_message', 'reply'],
    commitmentProposal: {
      text: '我明天帮你整理面试资料',
      messageText,
      targetId: '22',
      dueAt: base + 86400000,
      evidenceIds: [evidenceId],
    },
    ...over,
  });
}

await test('successful-send-activates-matching-proposal', async () => {
  const evidenceId = nextEvidenceId();
  const messageText = '我明天帮你整理面试资料，整理好就发你。';
  const logs = [];
  const world = makeWorld({ provider: providerDecision(messageText, evidenceId) });
  world.ctx.log = (...args) => logs.push(args.join(' '));
  seedInbound(world, evidenceId);
  const decision = await world.ctx.attachWakeDecision('group:1', 'request');
  assert.equal(decision.decisionId, 'model-dec-commitment');
  const proposed = commitmentsMod.listCommitments({ scopes: ['group:1'], statuses: ['proposed'] });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].decision_id, 'model-dec-commitment');
  const sent = await world.ctx.sendMessagesV2('group:1', [messageText], [], null, null, {
    executionId: world.st.activeExecutionId, action: 'send_message',
  });
  assert.equal(sent.length, 1);
  const row = commitmentsMod.getCommitment({ id: proposed[0].id });
  assert.equal(row.status, 'active');
  assert.match(row.send_ref, /^qq:group:1:/);
  assert.equal(JSON.parse(row.evidence_json).some((x) => x.kind === 'send' && x.success === true), true);
  return { decision: decision.decisionId, status: row.status, sendRef: row.send_ref };
});

await test('failed-send-does-not-activate', async () => {
  const evidenceId = nextEvidenceId();
  const messageText = '我明天帮你整理面试资料，整理好就发你。';
  const world = makeWorld({ provider: providerDecision(messageText, evidenceId) });
  seedInbound(world, evidenceId);
  await world.ctx.attachWakeDecision('group:1', 'request');
  const proposed = commitmentsMod.listCommitments({ scopes: ['group:1'], statuses: ['proposed'] });
  world.ctx.onebotSend = async () => { throw new Error('transport-down'); };
  let error = null;
  try { await world.ctx.sendMessagesV2('group:1', [messageText], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' }); }
  catch (e) { error = e; }
  assert.ok(error);
  const row = commitmentsMod.getCommitment({ id: proposed[0].id });
  assert.equal(row.status, 'proposed');
  return { status: row.status, error: error.message };
});

await test('unknown-transport-does-not-activate', async () => {
  const evidenceId = nextEvidenceId();
  const messageText = '我明天帮你整理面试资料，整理好就发你。';
  const world = makeWorld({ provider: providerDecision(messageText, evidenceId) });
  seedInbound(world, evidenceId);
  await world.ctx.attachWakeDecision('group:1', 'request');
  const proposed = commitmentsMod.listCommitments({ scopes: ['group:1'], statuses: ['proposed'] });
  world.ctx.onebotSend = async () => ({ unknown: true });
  await world.ctx.sendMessagesV2('group:1', [messageText], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  const row = commitmentsMod.getCommitment({ id: proposed[0].id });
  assert.equal(row.status, 'proposed');
  return { status: row.status };
});

await test('partial-send-only-activates-exact-message', async () => {
  const evidenceId = nextEvidenceId();
  const messageText = '我明天帮你整理面试资料，整理好就发你。';
  const world = makeWorld({ provider: providerDecision(messageText, evidenceId) });
  seedInbound(world, evidenceId);
  await world.ctx.attachWakeDecision('group:1', 'request');
  const proposed = commitmentsMod.listCommitments({ scopes: ['group:1'], statuses: ['proposed'] });
  world.ctx.onebotSend = async (...args) => {
    const text = args[2];
    if (text === messageText) return { message_id: 'ok-1' };
    throw new Error('second-message-failed');
  };
  let error = null;
  try {
    await world.ctx.sendMessagesV2('group:1', [messageText, '无关的第二条'], [1], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  } catch (e) { error = e; }
  assert.ok(error);
  const row = commitmentsMod.getCommitment({ id: proposed[0].id });
  assert.equal(row.status, 'active');
  return { status: row.status, sent: error.sent?.length ?? 0 };
});

await test('tool-result-fulfills-active-commitment', async () => {
  const evidenceId = nextEvidenceId();
  const messageText = '这是整理好的面试资料。';
  const world = makeWorld({ provider: providerDecision('旧提案文本', evidenceId) });
  seedInbound(world, evidenceId);
  await world.ctx.attachWakeDecision('group:1', 'request');
  const oldProposal = commitmentsMod.listCommitments({ scopes: ['group:1'], statuses: ['proposed'] })[0];
  // 先由一次成功发送激活；本轮测试只关心后续工具结果完成链。
  await world.ctx.sendMessagesV2('group:1', ['旧提案文本'], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  const completion = { commitmentId: oldProposal.id, messageText, targetId: '22' };
  const fulfillDecision = {
    decisionId: 'model-dec-fulfill', intent: 'help', engagement: 'normal',
    reasonCodes: ['tool-result'], evidenceIds: [], allowedActions: ['send_message'],
    commitmentProposal: null, commitmentCompletion: completion, contextRevision: 3,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  world.st.decisionEpoch = (Number(world.st.decisionEpoch) || 0) + 1;
  world.st.activeDecision = fulfillDecision;
  const ex = execMod.createExecutionContext({ key: 'group:1', decision: fulfillDecision, sessionId: null, epoch: world.st.decisionEpoch, seq: world.st.lastUnreadSeq, now: Date.now(), ttlMs: 3600000 });
  world.st.activeExecution = ex;
  world.st.activeExecutionId = ex.executionId;
  world.ctx.executionContexts.set(ex.executionId, ex);
  const sent = await world.ctx.sendMessagesV2('group:1', [messageText], [], null, null, { executionId: ex.executionId, action: 'send_message' });
  assert.equal(sent.length, 1);
  const row = commitmentsMod.getCommitment({ id: oldProposal.id });
  assert.equal(row.status, 'fulfilled');
  assert.equal(row.fulfillment_tool, 'qq-transport');
  assert.match(row.fulfillment_ref, /^qq:group:1:/);
  return { status: row.status, fulfillment: row.fulfillment_ref };
});

await test('duplicate-receipt-is-idempotent', async () => {
  const evidenceId = nextEvidenceId();
  const messageText = '我明天帮你整理面试资料，整理好就发你。';
  const world = makeWorld({ provider: providerDecision(messageText, evidenceId) });
  seedInbound(world, evidenceId);
  await world.ctx.attachWakeDecision('group:1', 'request');
  const proposed = commitmentsMod.listCommitments({ scopes: ['group:1'], statuses: ['proposed'] });
  await world.ctx.sendMessagesV2('group:1', [messageText], [], null, null, { executionId: world.st.activeExecutionId, action: 'send_message' });
  const afterFirst = commitmentsMod.getCommitment({ id: proposed[0].id });
  const again = commitmentsMod.activateCommitmentsForSendReceipt({
    scope: 'group:1', decision: { decisionId: 'model-dec-commitment' }, executionId: world.st.activeExecutionId,
    messageId: 'same', transportRef: afterFirst.send_ref, messageText, success: true,
  });
  assert.equal(again.activated, 0);
  const afterSecond = commitmentsMod.getCommitment({ id: proposed[0].id });
  assert.equal(afterSecond.status, 'active');
  assert.equal(afterSecond.send_ref, afterFirst.send_ref);
  return { status: afterSecond.status, sendRef: afterSecond.send_ref };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r1-bridge-commitments-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
