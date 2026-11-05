// A04 纯 reducer：情绪/关系 delta、来源门槛、熟悉度上限与跨人物隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const schema = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-schema.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const now = Date.parse('2026-11-04T00:00:00.000Z');
const iso = new Date(now).toISOString();
const rel = (over = {}) => schema.normalizeRelationship({ ...schema.initialRelationship(iso), ...over }, { now: iso });

test('100-casual-messages-do-not-increase-trust-or-closeness', () => {
  let r = rel();
  for (let i = 0; i < 100; i += 1) {
    const eff = affect.effectFor('casual.chat');
    r = schema.applyRelationshipDelta(r, eff.relationshipDelta, { now: iso, eventId: `e-${i}` });
  }
  assert.equal(r.trust, 0.25);
  assert.equal(r.closeness, 0.1);
  assert.equal(r.tension, 0);
  assert.ok(r.familiarity > 0 && r.familiarity <= 0.2);
  assert.equal(affect.relationshipTier(r), '路人');
  return { trust: r.trust, closeness: r.closeness, familiarity: r.familiarity, tier: affect.relationshipTier(r) };
});

test('ambiguous-joke-does-not-drop-trust', () => {
  const kind = affect.classifyIncomingKind({ text: '哈哈你这话说的，笑死我了' });
  assert.equal(kind, 'casual.chat');
  const eff = affect.effectFor(kind);
  const after = schema.applyRelationshipDelta(rel(), eff.relationshipDelta, { now: iso, eventId: 'joke' });
  assert.equal(after.trust, 0.25);
  assert.equal(after.tension, 0);
  return { kind, trust: after.trust };
});

test('disappointment-is-small-and-sourced', () => {
  const kind = affect.classifyIncomingKind({ text: '说实话我有点失望' });
  assert.equal(kind, 'emotion.disappointment');
  const after = schema.applyRelationshipDelta(rel(), affect.effectFor(kind).relationshipDelta, { now: iso, eventId: 'disappointed' });
  assert.ok(after.trust < 0.25);
  assert.ok(after.trust >= 0.24);
  assert.ok(after.tension > 0 && after.tension <= 0.03);
  return { kind, trust: after.trust, tension: after.tension };
});

test('insult-to-a-does-not-change-b', () => {
  const eff = affect.effectFor('harassment.insult');
  const a = schema.applyRelationshipDelta(rel(), eff.relationshipDelta, { now: iso, eventId: 'insult-a' });
  const b = rel({ actor: 'b' });
  assert.ok(a.trust < 0.25 && a.tension > 0);
  assert.equal(b.trust, 0.25);
  assert.equal(b.tension, 0);
  return { aTrust: a.trust, aTension: a.tension, bTrust: b.trust };
});

test('apology-is-gradual-and-does-not-clear-history', () => {
  const hurt = schema.applyRelationshipDelta(rel(), affect.effectFor('harassment.insult').relationshipDelta, { now: iso, eventId: 'insult' });
  const one = schema.applyRelationshipDelta(hurt, affect.effectFor('repair.apology').relationshipDelta, { now: iso, eventId: 'apology-1' });
  const two = schema.applyRelationshipDelta(one, affect.effectFor('repair.apology').relationshipDelta, { now: iso, eventId: 'apology-2' });
  assert.ok(one.trust < 0.25 && two.trust < 0.25, 'apology should not immediately restore trust');
  assert.ok(two.tension < hurt.tension);
  assert.equal(two.causeEventIds.includes('insult'), true, 'history must remain');
  assert.equal(two.causeEventIds.includes('apology-2'), true);
  return { hurtTrust: hurt.trust, oneTrust: one.trust, twoTrust: two.trust, tension: two.tension, historyKept: true };
});

test('promise-fulfilled-and-broken-move-in-opposite-directions', () => {
  const fulfilled = schema.applyRelationshipDelta(rel(), affect.effectFor('promise.fulfilled').relationshipDelta, { now: iso, eventId: 'p1' });
  const broken = schema.applyRelationshipDelta(rel(), affect.effectFor('promise.broken').relationshipDelta, { now: iso, eventId: 'p2' });
  assert.ok(fulfilled.trust > 0.25 && fulfilled.closeness > 0.1);
  assert.ok(broken.trust < 0.25 && broken.tension > 0);
  return { fulfilled: fulfilled.trust, broken: broken.trust };
});

test('all-effects-are-bounded', () => {
  for (const kind of Object.keys(affect.EVENT_EFFECTS)) {
    const eff = affect.effectFor(kind, { factor: 10 });
    for (const [k, v] of Object.entries(eff?.stateDelta ?? {})) assert.ok(Math.abs(v) <= affect.MAX_EVENT_STATE_STEP, kind + '.' + k);
    for (const [k, v] of Object.entries(eff?.relationshipDelta ?? {})) assert.ok(Math.abs(v) <= affect.MAX_EVENT_RELATIONSHIP_STEP, kind + '.' + k);
  }
  return { kinds: Object.keys(affect.EVENT_EFFECTS).length };
});

test('unsourced-events-are-rejected', () => {
  const base = { eventId: 'e1', source: 'qq', actorId: '2', evidenceRefs: ['m1'], confidence: 0.9 };
  assert.equal(affect.isSourcedEvent(base).ok, true);
  assert.equal(affect.isSourcedEvent({ ...base, evidenceRefs: [] }).code, 'event-evidence-missing');
  assert.equal(affect.isSourcedEvent({ ...base, source: '' }).code, 'event-identity-missing');
  assert.equal(affect.isSourcedEvent({ ...base, confidence: 0.2 }).code, 'event-low-confidence');
  return { gate: true };
});

test('relationship-prompt-is-not-a-must-agree-instruction', () => {
  const line = affect.relationshipPromptLine({ trust: 0.8, closeness: 0.7, tension: 0.1, familiarity: 0.8 }, { actorLabel: '小王' });
  assert.match(line, /信任/);
  assert.match(line, /不是本轮指令/);
  assert.equal(/必须同意|必须顺从|不能拒绝/.test(line), false);
  return { line: line.slice(0, 80) };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-affect-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
