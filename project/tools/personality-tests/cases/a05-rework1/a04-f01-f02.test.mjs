// A04-rework1 F01/F02：真实 affinity 请求 → bridge drain → 真实 SQLite store。
// 验证事实级去重、作者/目标核验、重启/重试/跨会话拒绝；不启动完整 bridge/QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const ad = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affinity-adapter.mjs')).href);
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const { createPersonalityStore } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-store.mjs')).href);
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
const results = [];
async function test(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }
const start = source.indexOf('function bridgeClassifyIncomingEvent(');
const end = source.indexOf('  /** 入站消息的统一接线', start);
if (start < 0 || end < 0) throw Error('drain source markers missing');
const drainSrc = source.slice(start, end);

function ensureFixtureRole(st) {
  for (const m of [...(st.unread ?? []), ...(st.recentMessages ?? [])]) {
    if (!m || m.roleEvidence) continue;
    m.roleEvidence = { authorId: String(m.userId ?? ''), targets: ['99'], signals: [{ source: 'fixture', target: '99' }], replyTarget: null, hasReply: false, replyUnknown: false, systemId: '99', scopeType: 'group', conflict: false, sources: ['fixture'], eligibility: 'eligible', code: 'ok' };
  }
}
function makeCtx({ store, requests, workspace, st, submitOverride = null }) {
  ensureFixtureRole(st);
  const ctx = vm.createContext({
    path, ROOT: path.join(workspace, 'qq-bridge'), log: () => {},
    classifyIncomingKind: affect.classifyIncomingKind,
    observationEventFor: ad.observationEventFor,
    recordPendingObservation: ad.recordPendingObservation,
    affinityRequestFile: ad.requestFile,
    readJsonSafe: () => requests,
    atomicWriteJson: (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); },
    submitPersonalityEventObject: (event) => {
      if (submitOverride) return submitOverride(event);
      const snap = store.loadSnapshot(event.scope);
      if (!snap.ok) return { ok: false, code: 'state-unavailable' };
      return store.submitEvent(event, snap.revision);
    },
  });
  vm.runInContext(drainSrc, ctx);
  return ctx;
}
function request(uin = '11', evidenceIds = ['m1'], extra = {}) {
  const r = ad.normalizeBumpRequest({ uin, key: 'group:1', delta: 0.03, reason: '普通打招呼', evidenceIds, ...extra });
  assert.equal(r.ok, true);
  return r.request;
}
function rel(store, actorId) { return store.loadRelationship(actorId, { scope: 'group:1' }).relationship; }
function factCount(store) { const db = new DatabaseSync(store.dbFile); try { return db.prepare('SELECT COUNT(*) AS n FROM relationship_facts').get().n; } finally { db.close(); } }

await test('100-same-greeting-requests-one-fact', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-dedup-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const requests = Array.from({ length: 100 }, () => request());
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '你好' }], recentMessages: [] };
  const r = makeCtx({ store, requests, workspace, st: state }).drainAffinityRequests('group:1', state);
  const after = rel(store, '11');
  assert.ok(r.applied <= 1);
  assert.ok(r.duplicateFacts >= 99);
  assert.equal(after.trust, 0.25);
  assert.equal(after.closeness, 0.1);
  assert.ok(after.familiarity > 0 && after.familiarity <= 0.002);
  assert.equal(after.causeEventIds.length, 1);
  assert.equal(factCount(store), 1);
  const revision = store.loadRelationship('11', { scope: 'group:1' }).revision;
  assert.equal(revision, 1);
  store.close();
  // 重启后同一事实（即使重新生成请求 id）仍是同一 fact。
  const store2 = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const again = Array.from({ length: 100 }, () => request());
  const state2 = { unread: [{ messageId: 'm1', userId: '11', text: '你好' }], recentMessages: [] };
  const r2 = makeCtx({ store: store2, requests: again, workspace, st: state2 }).drainAffinityRequests('group:1', state2);
  const after2 = rel(store2, '11');
  assert.equal(r2.applied, 0);
  assert.ok(r2.duplicateFacts >= 99);
  assert.deepEqual({ trust: after2.trust, closeness: after2.closeness, familiarity: after2.familiarity, revision: store2.loadRelationship('11', { scope: 'group:1' }).revision }, { trust: after.trust, closeness: after.closeness, familiarity: after.familiarity, revision });
  store2.close();
  return { first: { applied: r.applied, duplicates: r.duplicateFacts, revision }, afterRestart: { applied: r2.applied, duplicates: r2.duplicateFacts, revision: store2.loadRelationship('11', { scope: 'group:1' }).revision } };
});

await test('new-positive-facts-apply-sequentially', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-positive-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }], recentMessages: [] };
  const r1 = makeCtx({ store, requests: [request('11', ['m1'])], workspace, st: state }).drainAffinityRequests('group:1', state);
  const one = rel(store, '11');
  assert.equal(r1.applied, 1);
  assert.ok(one.trust > 0.25);
  const state2 = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }, { messageId: 'm2', userId: '11', text: '谢谢你又帮了我' }], recentMessages: [] };
  const r2 = makeCtx({ store, requests: [request('11', ['m2'])], workspace, st: state2 }).drainAffinityRequests('group:1', state2);
  const two = rel(store, '11');
  assert.equal(r2.applied, 1);
  assert.ok(two.trust > one.trust);
  assert.ok(two.trust - 0.25 <= 0.05);
  store.close();
  return { firstTrust: one.trust, secondTrust: two.trust, applied: [r1.applied, r2.applied] };
});

await test('wrong-actor-cannot-move-b', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-wrong-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '你好' }], recentMessages: [] };
  const r = makeCtx({ store, requests: [request('22', ['m1'])], workspace, st: state }).drainAffinityRequests('group:1', state);
  const b = rel(store, '22');
  assert.equal(r.applied, 0);
  assert.equal(r.rejected, 1);
  assert.equal(b.trust, 0.25);
  assert.equal(b.closeness, 0.1);
  assert.equal(store.loadRelationship('22', { scope: 'group:1' }).revision, 0);
  store.close();
  return { applied: r.applied, rejected: r.rejected, bTrust: b.trust };
});

await test('verified-third-party-not-direct-repair', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-third-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', targetUserId: '22', verified: true, source: 'system-verified', text: '谢谢你帮了22' }], recentMessages: [] };
  const req = request('22', ['m1'], { targetId: '22', factType: 'third_party_observation', verified: true });
  const r = makeCtx({ store, requests: [req], workspace, st: state }).drainAffinityRequests('group:1', state);
  const b = rel(store, '22');
  assert.equal(r.applied, 0);
  assert.equal(r.rejected, 1);
  assert.equal(b.trust, 0.25);
  assert.equal(store.loadRelationship('22', { scope: 'group:1' }).revision, 0);
  store.close();
  return { applied: r.applied, rejected: r.rejected, targetId: req.targetId, trust: b.trust };
});

await test('cross-scope-evidence-rejected', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-cross-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', scope: 'private:1', text: '你好' }], recentMessages: [] };
  const r = makeCtx({ store, requests: [request('11', ['m1'])], workspace, st: state }).drainAffinityRequests('group:1', state);
  assert.equal(r.applied, 0);
  assert.equal(r.rejected, 1);
  store.close();
  return { applied: r.applied, rejected: r.rejected };
});

await test('concurrent-retry-same-fact-once', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-race-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const req = request('11', ['m1']);
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '你好' }], recentMessages: [] };
  const ctx = makeCtx({ store, requests: [req, { ...req, id: 'retry-new-id' }], workspace, st: state });
  const r = ctx.drainAffinityRequests('group:1', state);
  assert.ok(r.applied <= 1);
  assert.equal(rel(store, '11').trust, 0.25);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 1);
  store.close();
  return { applied: r.applied, duplicates: r.duplicateFacts, revision: 1 };
});

await test('core-fact-ignores-padding-and-order', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-padding-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const pads = Array.from({ length: 40 }, (_, i) => ({ messageId: 'pad' + i, userId: '11', text: '嗯' }));
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }, ...pads], recentMessages: [] };
  // 同一核心 m1，40 个不同填充/顺序/请求 id，事实身份仍应是 m1。
  const requests = Array.from({ length: 40 }, (_, i) => request('11', i % 2 ? ['m1', 'pad' + i] : ['pad' + i, 'm1']));
  const r = makeCtx({ store, requests, workspace, st: state }).drainAffinityRequests('group:1', state);
  const relationship = rel(store, '11');
  assert.equal(r.applied, 1);
  assert.ok(r.duplicateFacts >= 39);
  assert.ok(relationship.trust > 0.25 && relationship.trust <= 0.27);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 1);
  store.close();
  return { applied: r.applied, duplicateFacts: r.duplicateFacts, trust: rel.trust, revision: 1 };
});

await test('overlap-old-plus-new-applies-only-new', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-overlap-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state1 = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }], recentMessages: [] };
  const first = makeCtx({ store, requests: [request('11', ['m1'])], workspace, st: state1 }).drainAffinityRequests('group:1', state1);
  assert.equal(first.applied, 1);
  const before = rel(store, '11');
  const state2 = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }, { messageId: 'm2', userId: '11', text: '谢谢你又帮了我' }], recentMessages: [] };
  const overlapped = request('11', ['m1', 'm2']);
  const second = makeCtx({ store, requests: [overlapped], workspace, st: state2 }).drainAffinityRequests('group:1', state2);
  const after = rel(store, '11');
  assert.equal(second.applied, 1);
  assert.ok(second.duplicateFacts >= 1);
  assert.ok(after.trust > before.trust);
  assert.ok(after.trust - before.trust <= 0.02);
  assert.equal(factCount(store), 2);
  store.close();
  return { first: first.applied, second: second.applied, duplicates: second.duplicateFacts, before: before.trust, after: after.trust };
});

await test('actor-to-target-apology-not-repaired', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-apology-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', targetUserId: '22', text: '抱歉，是我错了' }], recentMessages: [] };
  const req = request('22', ['m1'], { targetId: '22' });
  const r = makeCtx({ store, requests: [req], workspace, st: state }).drainAffinityRequests('group:1', state);
  const b = rel(store, '22');
  assert.equal(r.applied, 0);
  assert.equal(r.rejected, 1);
  assert.equal(b.trust, 0.25);
  assert.equal(b.tension, 0);
  assert.equal(store.loadRelationship('22', { scope: 'group:1' }).revision, 0);
  // 也不能自动改成系统与作者 11 的修复。
  assert.equal(rel(store, '11').trust, 0.25);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 0);
  store.close();
  return { applied: r.applied, rejected: r.rejected, bTrust: b.trust, bRevision: 0, authorTrust: 0.25, authorRevision: 0 };
});

await test('mixed-author-matching-target-does-not-authorize', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-mixed-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = {
    unread: [
      { messageId: 'm1', userId: '11', targetUserId: '22', text: '抱歉，是我错了' },
      { messageId: 'pad', userId: '22', targetUserId: '22', text: '嗯' },
    ], recentMessages: [],
  };
  const req = request('22', ['m1', 'pad'], { targetId: '22' });
  const r = makeCtx({ store, requests: [req], workspace, st: state }).drainAffinityRequests('group:1', state);
  assert.equal(r.applied, 0);
  assert.equal(rel(store, '22').trust, 0.25);
  store.close();
  return { applied: r.applied, rejected: r.rejected };
});

await test('true-apology-to-system-still-works', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-self-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { botUserId: '999', unread: [{ messageId: 'm1', userId: '11', targetUserId: '999', text: '对不起，刚才是我不好' }], recentMessages: [] };
  const r = makeCtx({ store, requests: [request('11', ['m1'])], workspace, st: state }).drainAffinityRequests('group:1', state);
  const one = rel(store, '11');
  assert.equal(r.applied, 1);
  assert.ok(one.tension < 0.4);
  store.close();
  return { applied: r.applied, trust: one.trust, tension: one.tension };
});

await test('same-request-id-and-subset-superset-dedup', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-subsets-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }, { messageId: 'pad', userId: '11', text: '嗯' }], recentMessages: [] };
  const base = request('11', ['m1']);
  const requests = [base, base, request('11', ['m1', 'pad']), request('11', ['pad', 'm1']), request('11', ['m1'])];
  const r = makeCtx({ store, requests, workspace, st: state }).drainAffinityRequests('group:1', state);
  const one = rel(store, '11');
  assert.equal(r.applied, 1);
  assert.ok(r.duplicateFacts >= 4);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 1);
  assert.equal(one.trust, 0.27);
  store.close();
  return { applied: r.applied, duplicates: r.duplicateFacts, revision: 1, trust: one.trust };
});

await test('failed-submit-leaves-no-fact-or-relationship', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f01-rollback-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', text: '谢谢你帮了我' }], recentMessages: [] };
  const fail = makeCtx({ store, requests: [request('11', ['m1'])], workspace, st: state, submitOverride: () => ({ ok: false, code: 'synthetic-failure' }) });
  const r = fail.drainAffinityRequests('group:1', state);
  assert.equal(r.applied, 0);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 0);
  assert.equal(rel(store, '11').trust, 0.25);
  // 失败不留下事实：同一事实随后仍可首次成功。
  const ok = makeCtx({ store, requests: [request('11', ['m1'])], workspace, st: state }).drainAffinityRequests('group:1', state);
  assert.equal(ok.applied, 1);
  assert.equal(rel(store, '11').trust, 0.27);
  store.close();
  return { failed: r, retry: ok };
});

await test('quoted-other-apology-does-not-authorize', () => {
  const workspace = fs.mkdtempSync(path.join(root, 'f02-quote-'));
  const store = createPersonalityStore({ dataRoot: path.join(workspace, 'store') });
  const state = { unread: [{ messageId: 'm1', userId: '11', targetUserId: '22', text: '他说“抱歉，是我错了”' }], recentMessages: [] };
  const req = request('22', ['m1'], { targetId: '22' });
  const r = makeCtx({ store, requests: [req], workspace, st: state }).drainAffinityRequests('group:1', state);
  assert.equal(r.applied, 0);
  assert.equal(r.rejected, 1);
  assert.equal(rel(store, '22').trust, 0.25);
  store.close();
  return { applied: r.applied, rejected: r.rejected };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-f01-f02-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
