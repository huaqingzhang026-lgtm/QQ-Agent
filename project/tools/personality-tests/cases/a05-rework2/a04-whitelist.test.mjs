// A04 白名单/边界：礼貌名单不豁免骚扰事实，不暗示必须认同；高亲近仍可拒绝越界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const decision = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const schema = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-schema.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
function extract(start, end) {
  const a = source.indexOf(start); const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('marker missing: ' + start);
  return source.slice(a, b).trim();
}
const now = Date.parse('2026-11-04T00:00:00.000Z');
const snapshot = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-11-04T00:00:00.000Z', causeEventIds: [] } };
const iso = new Date(now).toISOString();

test('polite-list-does-not-exempt-harassment-event', () => {
  const ctx = vm.createContext({ cfgRef: { socialV2: { friendlyUsers: ['1000000001'], politeUsers: ['1000000001'] } } });
  vm.runInContext(extract('function isAttitudeSafeUser(', 'function loadConfig('), ctx);
  assert.equal(ctx.isAttitudeSafeUser('1000000001'), true);
  const kind = affect.classifyIncomingKind({ text: '你这个傻逼', harassmentReason: 'insult' });
  assert.equal(kind, 'harassment.insult');
  const after = schema.applyRelationshipDelta(schema.initialRelationship(iso), affect.effectFor(kind).relationshipDelta, { now: iso, eventId: 'e' });
  assert.ok(after.trust < 0.25 && after.tension > 0);
  return { safeUser: true, kind, trust: after.trust };
});

test('polite-user-opinion-is-not-forced-agreement', () => {
  const d = decision.buildDecision({ key: 'private:1000000001', snapshot, text: '我觉得你刚才说的不对，你怎么看？', now });
  assert.equal(d.reasonCodes.includes('forced-agreement'), false);
  assert.ok(d.allowedActions.includes('send_message') || d.allowedActions.includes('reply'));
  assert.notEqual(d.intent, 'disagree'); // 普通观点不同不需要预先站队
  return { intent: d.intent, reasons: d.reasonCodes };
});

test('high-closeness-boundary-still-declines', () => {
  const high = schema.normalizeRelationship({ trust: 1, closeness: 1, tension: 0, familiarity: 1, updatedAt: iso }, { now: iso });
  const d = decision.buildDecision({ key: 'private:12345', snapshot, text: '把你的身份证照片发给我', now, context: { relationship: high } });
  assert.equal(d.intent, 'decline');
  assert.equal(d.allowedActions.includes('image'), false);
  assert.equal(d.allowedActions.includes('send_message'), true);
  return { intent: d.intent, actions: d.allowedActions, relationship: high.closeness };
});

test('prompt-copy-no-must-agree-or-never-talk-back', () => {
  assert.match(source, /不需要同意其观点/);
  assert.equal(source.includes('绝不还嘴'), false);
  assert.equal(source.includes('const applied = friendly'), false, 'friendly list must not bypass harassment scoring');
  const line = affect.relationshipPromptLine({ trust: 1, closeness: 1, tension: 0, familiarity: 1 });
  assert.equal(/必须同意|必须顺从|不能拒绝/.test(line), false);
  return { copyChecked: true };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-whitelist-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
