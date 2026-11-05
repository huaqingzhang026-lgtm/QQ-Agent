// A04 bridge 集成：统一事件入口、关系/情绪更新、决策结果、affinity 请求消费。
// 真实 bridge 事件函数切片 + 真实 personality store；传输/模型不参与。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-store.mjs')).href);
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const adapter = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affinity-adapter.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
function extract(start, end) {
  const a = source.indexOf(start); const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('marker missing: ' + start);
  return source.slice(a, b).trim();
}
function harness() {
  const workspace = fs.mkdtempSync(path.join(root, 'a04-bridge-'));
  const bridgeRoot = path.join(workspace, 'qq-bridge');
  const stateDir = path.join(bridgeRoot, 'state');
  fs.mkdirSync(path.join(stateDir, 'personality'), { recursive: true });
  const logs = [];
  const ctx = vm.createContext({
    ROOT: bridgeRoot,
    STATE_DIR: stateDir,
    path,
    crypto,
    personalityStore: null,
    personalityStoreRoot: '',
    cfg: { socialV2: { personalityV2: { enabled: true, dataRoot: 'state/personality', relationship: { casualCooldownMs: 0, positiveCooldownMs: 60000 } } } },
    personalityEnabled: () => true,
    createPersonalityStore: storeMod.createPersonalityStore,
    relationshipTier: affect.relationshipTier,
    affinityScore: affect.affinityScore,
    effectFor: affect.effectFor,
    classifyIncomingKind: affect.classifyIncomingKind,
    relationshipPromptLine: affect.relationshipPromptLine,
    isSourcedEvent: affect.isSourcedEvent,
    observationEventFor: adapter.observationEventFor,
    recordPendingObservation: adapter.recordPendingObservation,
    affinityRequestFile: adapter.requestFile,
    readJsonSafe: (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } },
    atomicWriteJson: (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); },
    log: (...args) => logs.push(args.join(' ')),
  });
  const src = extract('function getPersonalityStore(', 'function stateUnavailableDecision(');
  vm.runInContext(src, ctx);
  const store = ctx.getPersonalityStore();
  return { ctx, store, workspace, bridgeRoot, stateDir, logs };
}
function st() {
  const roleEvidence = { authorId: '12345', targets: ['99'], signals: [{ source: 'fixture', target: '99' }], replyTarget: null, hasReply: false, replyUnknown: false, systemId: '99', scopeType: 'group', conflict: false, sources: ['fixture'], eligibility: 'eligible', code: 'ok' };
  return { unread: [{ seq: 1, messageId: 'm1', userId: '12345', text: '你好', roleEvidence }], recentMessages: [{ seq: 1, messageId: 'm1', userId: '12345', text: '你好', roleEvidence }] };
}

await test('harassment-event-updates-state-and-relationship-once', async () => {
  const h = harness();
  const first = h.ctx.emitPersonalityEvent({ scope: 'group:1', actorId: '12345', messageId: 'm1', kind: 'harassment.insult', source: 'harassment', confidence: 0.95 });
  assert.equal(first.ok, true);
  assert.equal(first.applied, true);
  const snap = h.store.loadSnapshot('group:1');
  assert.equal(snap.snapshot.state.valence, -0.08);
  assert.equal(snap.snapshot.state.stress, 0.32);
  assert.equal(snap.snapshot.relationships['12345'].trust, 0.19);
  const second = h.ctx.emitPersonalityEvent({ scope: 'group:1', actorId: '12345', messageId: 'm1', kind: 'harassment.insult', source: 'harassment', confidence: 0.95 });
  assert.equal(second.duplicate, true);
  const snap2 = h.store.loadSnapshot('group:1');
  assert.equal(snap2.snapshot.state.valence, -0.08);
  assert.equal(snap2.snapshot.relationships['12345'].trust, 0.19);
  return { trust: snap2.snapshot.relationships['12345'].trust, duplicate: second.duplicate };
});

await test('casual-events-only-increase-familiarity', async () => {
  const h = harness();
  for (let i = 0; i < 20; i += 1) h.ctx.emitPersonalityEvent({ scope: 'group:1', actorId: '12345', messageId: 'c' + i, kind: 'casual.chat', source: 'qq', confidence: 0.6 });
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(rel.trust, 0.25);
  assert.equal(rel.closeness, 0.1);
  assert.equal(rel.tension, 0);
  assert.ok(rel.familiarity > 0 && rel.familiarity <= 0.04);
  return { trust: rel.trust, familiarity: rel.familiarity };
});

await test('insult-to-a-does-not-change-b-relationship', async () => {
  const h = harness();
  h.ctx.emitPersonalityEvent({ scope: 'group:1', actorId: '11111', messageId: 'a1', kind: 'harassment.insult', source: 'harassment' });
  const a = h.store.loadRelationship('11111', { scope: 'group:1' }).relationship;
  const b = h.store.loadRelationship('22222', { scope: 'group:1' }).relationship;
  assert.ok(a.tension > 0);
  assert.equal(b.tension, 0);
  assert.equal(b.trust, 0.25);
  return { aTension: a.tension, bTension: b.tension };
});

await test('decision-help-event-is-throttled-by-positive-cooldown', async () => {
  const h = harness();
  const state = st();
  const decision = { decisionId: 'dec-1', intent: 'help', evidenceIds: ['m1'] };
  h.ctx.maybeEmitDecisionOutcome('group:1', state, decision);
  const one = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(one.closeness > 0.1);
  const before = one.closeness;
  h.ctx.maybeEmitDecisionOutcome('group:1', state, { ...decision, decisionId: 'dec-2' });
  const two = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(two.closeness, before);
  return { closeness: two.closeness, throttled: true };
});

await test('decision-repair-event-lowers-tension', async () => {
  const h = harness();
  h.ctx.emitPersonalityEvent({ scope: 'group:1', actorId: '12345', messageId: 'bad', kind: 'harassment.insult', source: 'harassment' });
  const hurt = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  h.ctx.maybeEmitDecisionOutcome('group:1', st(), { decisionId: 'dec-repair', intent: 'repair', evidenceIds: ['m1'] });
  const repaired = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(repaired.tension < hurt.tension);
  return { before: hurt.tension, after: repaired.tension };
});

await test('affinity-request-with-valid-evidence-applies-small-observation', async () => {
  const h = harness();
  const state = st();
  // F01: 普通“你好”只能贡献 familiarity；这里改用一条真实且有充分依据的正向事件，
  // 保留原断言的业务意图（有效证据可行、幅度有界），不把问候当成信任/亲近事实。
  for (const m of [...state.unread, ...state.recentMessages]) m.text = '谢谢你帮了我';
  const before = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  const file = adapter.requestFile(h.workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ id: 'req-1', uin: '12345', key: 'group:1', delta: 0.03, reason: '帮了忙', evidenceIds: ['m1'], at: Date.now() }]));
  const r = h.ctx.drainAffinityRequests('group:1', state);
  assert.equal(r.applied, 1);
  const after = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(after.trust > before.trust);
  assert.ok(after.trust - before.trust <= 0.030001);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  return { applied: r.applied, delta: after.trust - before.trust };
});

await test('affinity-request-with-fake-evidence-stays-unverified', async () => {
  const h = harness();
  const before = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  const file = adapter.requestFile(h.workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ id: 'req-2', uin: '12345', key: 'group:1', delta: 0.03, reason: '编的', evidenceIds: ['not-in-conversation'], at: Date.now() }]));
  const r = h.ctx.drainAffinityRequests('group:1', st());
  assert.equal(r.applied, 0);
  assert.equal(r.rejected, 1);
  const after = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(after.trust, before.trust);
  const pending = JSON.parse(fs.readFileSync(adapter.pendingFile(h.workspace), 'utf8'));
  assert.equal(pending[0].kind, 'unverified-evidence');
  return { applied: 0, rejected: 1, pending: pending.length };
});

await test('incoming-hook-classifies-insult-and-repair-once', async () => {
  const h = harness();
  const state = st();
  const insult = h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', message_id: 'm1' }, '你这个傻逼', { reason: 'insult' }, state);
  assert.equal(insult.ok, true);
  const afterInsult = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(afterInsult.tension > 0);
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'm2', message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '对不起，刚才是我不好' } }] }, '对不起，刚才是我不好', null, state);
  const afterRepair = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(afterRepair.tension < afterInsult.tension);
  assert.ok(afterRepair.causeEventIds.length >= 2);
  return { insultTension: afterInsult.tension, repairTension: afterRepair.tension };
});

await test('incoming-casual-hook-respects-cooldown', async () => {
  const h = harness();
  const state = st();
  h.ctx.cfg.socialV2.personalityV2.relationship.casualCooldownMs = 60000;
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', message_id: 'c1' }, '你好', null, state);
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', message_id: 'c2' }, '在吗', null, state);
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(rel.familiarity, 0.002);
  assert.equal(rel.trust, 0.25);
  return { familiarity: rel.familiarity, trust: rel.trust };
});

await test('false-repair-language-does-not-change-relationship', async () => {
  const h = harness();
  const state = st();
  for (const [id, text] of [['q1', '“对不起”用英语怎么说？'], ['q2', '我没有错，不需要你原谅我'], ['q3', '解释一下这段代码'], ['q4', '他说“对不起”'], ['q5', '我不会说对不起，也不会原谅你']]) {
    h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', message_id: id }, text, null, state);
  }
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(rel.trust, 0.25);
  assert.equal(rel.closeness, 0.1);
  assert.equal(rel.tension, 0);
  assert.equal(rel.familiarity, 0);
  return { trust: rel.trust, closeness: rel.closeness, tension: rel.tension };
});

await test('apology-variants-not-negated', () => {
  const texts = ['对不起，是我错了', '对不起，我刚才说错了', '抱歉，是我错了'];
  const kinds = texts.map((text) => affect.classifyIncomingKind({ text }));
  assert.deepEqual(kinds, ['repair.apology', 'repair.apology', 'repair.apology']);
  return { texts, kinds };
});

await test('true-apology-and-explanation-can-repair', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', message_id: 'bad' }, '你这个傻逼', { reason: 'insult' }, state);
  const hurt = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'apology', message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '对不起，刚才是我不好' } }] }, '对不起，刚才是我不好', null, state);
  const afterApology = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(afterApology.tension < hurt.tension);
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'explain', message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '我不是那个意思，其实是因为当时太急了' } }] }, '我不是那个意思，其实是因为当时太急了', null, state);
  const afterExplanation = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(afterExplanation.tension < afterApology.tension);
  return { hurt: hurt.tension, apology: afterApology.tension, explanation: afterExplanation.tension };
});

await test('inbound-directed-other-does-not-repair-author', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'm22', targetUserId: '22', message: [{ type: 'at', data: { qq: '22' } }, { type: 'text', data: { text: '抱歉，是我错了' } }] }, '抱歉，是我错了', null, state);
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(rel.trust, 0.25);
  assert.equal(h.store.loadRelationship('12345', { scope: 'group:1' }).revision, 0);
  return { trust: rel.trust, revision: 0 };
});

await test('inbound-to-system-repair-works', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'ms', message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '对不起，是我错了' } }] }, '对不起，是我错了', null, state);
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.ok(rel.trust > 0.25);
  assert.ok(rel.tension < 0.4);
  return { trust: rel.trust, tension: rel.tension };
});

await test('inbound-group-no-target-is-conservative', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'mno' }, '对不起，是我错了', null, state);
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(rel.trust, 0.25);
  return { trust: rel.trust };
});

await test('inbound-private-repair-works', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('private:1', { user_id: '12345', self_id: '99', message_id: 'mp' }, '对不起，是我错了', null, state);
  const rel = h.store.loadRelationship('12345', { scope: 'private:1' }).relationship;
  assert.ok(rel.trust > 0.25);
  return { trust: rel.trust };
});

await test('inbound-multiple-at-and-reply-other-conservative', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'mm', message: [{ type: 'at', data: { qq: '22' } }, { type: 'at', data: { qq: '99' } }] }, '对不起，是我错了', null, state);
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'mr', reply: { sender: { user_id: '22' } } }, '对不起，是我错了', null, state);
  const rel = h.store.loadRelationship('12345', { scope: 'group:1' }).relationship;
  assert.equal(rel.trust, 0.25);
  assert.equal(h.store.loadRelationship('12345', { scope: 'group:1' }).revision, 0);
  return { trust: rel.trust, revision: 0 };
});

await test('inbound-then-affinity-same-fact-once', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'm1', message: [{ type: 'at', data: { qq: '99' } }] }, '谢谢你帮了我', null, state);
  const afterInbound = h.store.loadRelationship('12345', { scope: 'group:1' });
  const file = adapter.requestFile(h.workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([adapter.normalizeBumpRequest({ uin: '12345', key: 'group:1', delta: 0.03, reason: 'same fact', evidenceIds: ['m1'] }).request]));
  const r = h.ctx.drainAffinityRequests('group:1', state);
  const after = h.store.loadRelationship('12345', { scope: 'group:1' });
  assert.equal(r.applied, 0);
  assert.ok(r.duplicateFacts >= 1);
  assert.equal(after.revision, afterInbound.revision);
  assert.equal(after.relationship.trust, 0.27);
  return { applied: r.applied, duplicateFacts: r.duplicateFacts, revision: after.revision };
});

await test('affinity-then-inbound-same-fact-once', async () => {
  const h = harness();
  const state = st();
  for (const m of [...state.unread, ...state.recentMessages]) m.text = '谢谢你帮了我';
  const file = adapter.requestFile(h.workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([adapter.normalizeBumpRequest({ uin: '12345', key: 'group:1', delta: 0.03, reason: 'same fact', evidenceIds: ['m1'] }).request]));
  const first = h.ctx.drainAffinityRequests('group:1', state);
  assert.equal(first.applied, 1);
  const before = h.store.loadRelationship('12345', { scope: 'group:1' });
  const result = h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'm1', message: [{ type: 'at', data: { qq: '99' } }] }, '谢谢你帮了我', null, state);
  const after = h.store.loadRelationship('12345', { scope: 'group:1' });
  assert.equal(result.applied, false);
  assert.equal(result.duplicateFact, true);
  assert.equal(after.revision, before.revision);
  assert.equal(after.relationship.trust, 0.27);
  return { first: first.applied, second: result, revision: after.revision };
});

await test('decision-outcome-same-user-evidence-once', async () => {
  const h = harness();
  const state = st();
  h.ctx.processIncomingPersonalityEvent('group:1', { user_id: '12345', self_id: '99', message_id: 'm1', message: [{ type: 'at', data: { qq: '99' } }] }, '谢谢你帮了我', null, state);
  const before = h.store.loadRelationship('12345', { scope: 'group:1' });
  h.ctx.maybeEmitDecisionOutcome('group:1', state, { decisionId: 'dec-same', intent: 'help', evidenceIds: ['m1'] });
  const after = h.store.loadRelationship('12345', { scope: 'group:1' });
  assert.equal(after.revision, before.revision);
  assert.equal(after.relationship.trust, 0.27);
  return { before: before.revision, after: after.revision, trust: after.relationship.trust };
});

await test('affinity-projection-has-metrics-only', async () => {
  const h = harness();
  h.ctx.emitPersonalityEvent({ scope: 'group:1', actorId: '12345', messageId: 'm1', kind: 'harassment.insult', source: 'harassment' });
  const file = path.join(h.stateDir, 'affinity-projection.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = data.people['12345'];
  assert.ok(p);
  assert.equal(typeof p.trust, 'number');
  assert.equal('causeEventIds' in p, false);
  assert.equal('evidenceIds' in p, false);
  assert.equal('notes' in p, false);
  return { fields: Object.keys(p) };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-bridge-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
