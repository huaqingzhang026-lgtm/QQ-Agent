// A04-rework4：真实 append → 入站 → affinity → decision/重启的角色资格串联。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const aff = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const ad = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affinity-adapter.mjs')).href);
const { createPersonalityStore } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-store.mjs')).href);
const src = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
const factory = src.slice(src.indexOf('function makePersonalityEvent('), src.indexOf('function submitPersonalityEventObject('));
const helpers = src.slice(src.indexOf('function bridgeClassifyIncomingEvent('), src.indexOf('function stateUnavailableDecision('));
const append = src.slice(src.indexOf('function appendSocialV2Message('), src.indexOf('function appendSocialV2Poke('));
const results = [];
async function test(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

function harness() {
  const store = createPersonalityStore({ dataRoot: fs.mkdtempSync(path.join(root, 'r4-')) });
  const st = { botUserId: '99', unread: [], recentMessages: [], lastUnreadSeq: 0 };
  let requests = [];
  const pending = [];
  const events = [];
  const ctx = vm.createContext({
    path, crypto, ROOT: path.join(root, 'qq-bridge'), cfg: {},
    effectFor: aff.effectFor, affinityRequestFile: ad.requestFile,
    readJsonSafe: () => requests, recordPendingObservation: (_p, r) => pending.push(r),
    observationEventFor: ad.observationEventFor, classifyIncomingKind: aff.classifyIncomingKind,
    classifyIncomingEvent: aff.classifyIncomingEvent, classifyRelationshipEvidence: aff.classifyRelationshipEvidence,
    atomicWriteJson: (_p, r) => { requests = r; }, log: () => {},
    submitPersonalityEventObject: (e) => { const s = store.loadSnapshot(e.scope); const r = store.submitEvent(e, s.revision); events.push({ e, r }); return r; },
    getSocialV2State: () => st, truncateText: (s, n) => String(s).slice(0, n), truncateTextTail: (s, n) => String(s).slice(-n),
    sanitizeForwardId: (x) => x, invalidateActiveDecision: () => {}, saveSocialV2State: () => {}, addEvent: () => {},
    maybeStrongPersonaSignal: () => {},
  });
  vm.runInContext(factory + helpers + append, ctx);
  ctx.emitPersonalityEvent = (args) => ctx.submitPersonalityEventObject(ctx.makePersonalityEvent(args));
  return { store, st, ctx, events, pending, getRequests: () => requests, setRequests: (v) => { requests = v; } };
}
function add(h, key, event, text) {
  const role = h.ctx.inboundRoleEvidence(event, key, String(event.user_id), h.st);
  h.ctx.appendSocialV2Message(key, 'user11', text, text, false, false, event.message_id, [], String(event.user_id), [], role);
}
function affinity(h, key) {
  h.setRequests([ad.normalizeBumpRequest({ uin: '11', key, delta: 0.03, evidenceIds: ['m1'] }).request]);
  return h.ctx.drainAffinityRequests(key, h.st);
}
function rel(h, key = 'group:1') { return h.store.loadRelationship('11', { scope: key }); }
const event = (extra = {}) => ({ user_id: 11, self_id: 99, message_id: 'm1', message: [{ type: 'text', data: { text: '抱歉，是我错了' } }], ...extra });

await test('directed-other-inbound-then-affinity', () => {
  const h = harness(); const e = event({ message: [{ type: 'at', data: { qq: '22' } }, { type: 'text', data: { text: '抱歉，是我错了' } }] });
  add(h, 'group:1', e, '抱歉，是我错了');
  h.ctx.processIncomingPersonalityEvent('group:1', e, '抱歉，是我错了', null, h.st);
  const before = rel(h).relationship;
  const r = affinity(h, 'group:1');
  const after = rel(h).relationship;
  assert.equal(r.applied, 0); assert.ok(r.rejected >= 1);
  assert.equal(after.trust, 0.25); assert.equal(after.closeness, 0.1); assert.equal(after.tension, 0);
  assert.equal(rel(h).revision, 0);
  return { r, before, after, revision: rel(h).revision };
});

await test('directed-other-affinity-then-inbound', () => {
  const h = harness(); const e = event({ message: [{ type: 'at', data: { qq: '22' } }, { type: 'text', data: { text: '抱歉，是我错了' } }] });
  add(h, 'group:1', e, '抱歉，是我错了');
  const a = affinity(h, 'group:1');
  h.ctx.processIncomingPersonalityEvent('group:1', e, '抱歉，是我错了', null, h.st);
  const after = rel(h).relationship;
  assert.equal(a.applied, 0);
  assert.equal(after.trust, 0.25);
  assert.equal(rel(h).revision, 0);
  return { a, after, revision: rel(h).revision };
});

await test('unknown-group-then-affinity', () => {
  const h = harness(); const e = event();
  add(h, 'group:1', e, '抱歉，是我错了');
  h.ctx.processIncomingPersonalityEvent('group:1', e, '抱歉，是我错了', null, h.st);
  const a = affinity(h, 'group:1');
  assert.equal(a.applied, 0);
  assert.equal(rel(h).relationship.trust, 0.25);
  return { a, trust: rel(h).relationship.trust };
});

await test('system-target-normal-and-restart', () => {
  const h = harness(); const e = event({ message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '抱歉，是我错了' } }] });
  add(h, 'group:1', e, '抱歉，是我错了');
  h.ctx.processIncomingPersonalityEvent('group:1', e, '抱歉，是我错了', null, h.st);
  const one = rel(h).relationship;
  assert.ok(one.trust > 0.25);
  // restart: 保留持久消息角色依据后 affinity 不能重复计分
  const cloned = JSON.parse(JSON.stringify(h.st));
  h.setRequests([ad.normalizeBumpRequest({ uin: '11', key: 'group:1', delta: 0.03, evidenceIds: ['m1'] }).request]);
  const a = h.ctx.drainAffinityRequests('group:1', cloned);
  const after = rel(h).relationship;
  assert.equal(a.applied, 0); assert.ok(a.duplicateFacts >= 1);
  assert.equal(after.trust, one.trust); assert.equal(rel(h).revision, 1);
  return { trust: one.trust, restart: a, revision: rel(h).revision };
});

await test('private-target-normal', () => {
  const h = harness(); const e = event({ message: [{ type: 'text', data: { text: '抱歉，是我错了' } }] });
  add(h, 'private:1', e, '抱歉，是我错了');
  h.ctx.processIncomingPersonalityEvent('private:1', e, '抱歉，是我错了', null, h.st);
  const one = rel(h, 'private:1').relationship;
  assert.ok(one.trust > 0.25);
  return { trust: one.trust };
});

await test('at-reply-conflict-conservative-and-affinity', () => {
  const h = harness(); const e = event({ reply: { sender: { user_id: 22 } }, message: [{ type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: '抱歉，是我错了' } }] });
  add(h, 'group:1', e, '抱歉，是我错了');
  h.ctx.processIncomingPersonalityEvent('group:1', e, '抱歉，是我错了', null, h.st);
  const a = affinity(h, 'group:1');
  assert.equal(a.applied, 0);
  assert.equal(rel(h).relationship.trust, 0.25);
  return { a, trust: rel(h).relationship.trust, conflict: true };
});

await test('decision-outcome-cannot-revive-rejected-role', () => {
  const h = harness(); const e = event({ message: [{ type: 'at', data: { qq: '22' } }, { type: 'text', data: { text: '抱歉，是我错了' } }] });
  add(h, 'group:1', e, '抱歉，是我错了');
  h.ctx.processIncomingPersonalityEvent('group:1', e, '抱歉，是我错了', null, h.st);
  h.ctx.maybeEmitDecisionOutcome('group:1', h.st, { decisionId: 'dec-r4', intent: 'repair', evidenceIds: ['m1'] });
  assert.equal(rel(h).relationship.trust, 0.25);
  assert.equal(rel(h).revision, 0);
  return { trust: rel(h).relationship.trust, revision: rel(h).revision };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-r4-role-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
