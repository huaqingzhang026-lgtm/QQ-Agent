// A04-rework5：真实 loadSocialV2State（离线注入文件读取/状态依赖）后的旧消息
// 不得因缺少 roleEvidence 而获得关系增量。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const ad = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affinity-adapter.mjs')).href);
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const { createPersonalityStore } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-store.mjs')).href);
const src = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
const loadSrc = src.slice(src.indexOf('function loadSocialV2State('), src.indexOf('function saveSocialV2State('));
const helperSrc = src.slice(src.indexOf('function bridgeClassifyIncomingEvent('), src.indexOf('function stateUnavailableDecision('));
const factSrc = src.slice(src.indexOf('function makePersonalityEvent('), src.indexOf('function submitPersonalityEventObject('));
const results = [];
async function test(id, fn) { try { results.push({ id, ok: true, detail: await fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

await test('loaded-legacy-unknown-affinity-and-decision-conservative', () => {
  const store = createPersonalityStore({ dataRoot: fs.mkdtempSync(path.join(root, 'loader-')) });
  const oldMessage = { seq: 1, messageId: 'm1', sender: 'user11', userId: '11', text: '抱歉，是我错了', plain: '抱歉，是我错了', quoteTargetIsSelf: false, isSelf: false };
  let requests = [ad.normalizeBumpRequest({ uin: '11', key: 'group:1', delta: 0.03, evidenceIds: ['m1'] }).request];
  const pending = [];
  const socialV2 = { conversations: new Map(), paused: false, revision: 0, stateFp: null, schemaVersion: 1 };
  const ctx = vm.createContext({
    fs: { statSync: () => ({ size: 1, mtimeMs: 1 }) }, path, crypto,
    SOCIAL_V2_FILE: path.join(root, 'social-v2.json'),
    readStateFile: () => ({ data: { conversations: { 'group:1': { unread: [oldMessage], recentMessages: [oldMessage] } } }, revision: 1, fp: 'fp', schemaVersion: 1 }),
    socialV2,
    defaultWakeConfigV2: () => ({ triggers: {} }), pickWakeTriggersV2: (x) => ({ ...x }), normalizeSpeakerIdsV2: () => [],
    refreshDefaultWakeConfigV2: () => {}, rememberAgentToken: () => {}, sanitizeForwardId: (x) => x,
    ensureWakeableV2: () => {}, scheduleProactiveCheckV2: () => {}, saveSocialV2State: () => {}, log: () => {},
    ROOT: path.join(root, 'qq-bridge'), affinityRequestFile: ad.requestFile,
    readJsonSafe: () => requests, recordPendingObservation: (_p, r) => pending.push(r),
    observationEventFor: ad.observationEventFor, classifyIncomingKind: affect.classifyIncomingKind,
    classifyIncomingEvent: affect.classifyIncomingEvent, classifyRelationshipEvidence: affect.classifyRelationshipEvidence,
    atomicWriteJson: (_p, r) => { requests = r; },
    submitPersonalityEventObject: (e) => { const s = store.loadSnapshot(e.scope); return store.submitEvent(e, s.revision); },
  });
  vm.runInContext(loadSrc + helperSrc + factSrc, ctx);
  ctx.emitPersonalityEvent = (args) => ctx.submitPersonalityEventObject(ctx.makePersonalityEvent(args));
  ctx.loadSocialV2State();
  const loaded = socialV2.conversations.get('group:1');
  assert.ok(loaded);
  assert.equal(loaded.unread[0].roleEvidence ?? null, null);
  const r = ctx.drainAffinityRequests('group:1', loaded);
  assert.equal(r.applied, 0);
  assert.ok(r.rejected >= 1);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 0);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).relationship.trust, 0.25);
  assert.ok(pending.some((p) => p.kind === 'legacy-role-missing'));
  // decision 也不能复活旧格式消息
  ctx.maybeEmitDecisionOutcome('group:1', loaded, { decisionId: 'legacy-dec', intent: 'repair', evidenceIds: ['m1'] });
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).revision, 0);
  assert.equal(store.loadRelationship('11', { scope: 'group:1' }).relationship.trust, 0.25);
  store.close();
  return { drain: r, legacy: loaded.unread[0], pending: pending.map((p) => p.kind) };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-r5-loader-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
