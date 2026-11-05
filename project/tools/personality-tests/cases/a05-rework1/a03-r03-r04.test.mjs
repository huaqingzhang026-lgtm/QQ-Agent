const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
// A03-rework2 R03/R04：约束回退、语境反对、引用消歧（纯函数 + 真实 decideWithModel）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = CANDIDATE_ROOT;
const mod = await import(pathToFileURL(path.join(candidate, 'qq-bridge/src/personality-decision.mjs')).href);
const root = process.env.A00_DATA_ROOT;
const now = Date.parse('2026-10-31T00:00:00.000Z');
const snapshot = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [] } };
const recent = [{ seq: 7, messageId: 'm7', text: '不用回了' }];
const tests = [];
async function test(id, fn) { try { tests.push({ id, ok: true, detail: await fn() }); } catch (e) { tests.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

await test('fallback-ending-preserves-disengage', async () => {
  const r = await mod.decideWithModel({ model: () => { throw Error('provider'); }, key: 'private:1', snapshot, text: '不用回了', recent, now, timeoutMs: 1000, scheduler: { setTimeout: () => 1, clearTimeout: () => {} }, clock: () => now });
  assert.equal(r.source, 'code-fallback');
  assert.equal(r.decision.intent, 'disengage');
  assert.ok(!r.decision.allowedActions.includes('send_message'));
  return { intent: r.decision.intent, actions: r.decision.allowedActions, error: r.error };
});
await test('fallback-normal-clarify', async () => {
  const r = await mod.decideWithModel({ model: () => { throw Error('provider'); }, key: 'private:1', snapshot, text: '那个东西你懂的', recent, now, timeoutMs: 1000, scheduler: { setTimeout: () => 1, clearTimeout: () => {} }, clock: () => now });
  assert.equal(r.decision.intent, 'clarify');
  assert.ok(r.decision.allowedActions.includes('send_message'));
  return { intent: r.decision.intent, actions: r.decision.allowedActions };
});
await test('grounded-disagree-accepted', () => {
  const d = mod.buildDecision({ key: 'private:1', snapshot, text: '地球是平的吗？', recent: [{ seq: 8, messageId: 'm8', text: '地球是平的吗？' }], now });
  const r = mod.validateModelDecision({ ...d, intent: 'disagree', reasonCodes: ['factual-correction'], evidenceIds: ['m8'], allowedActions: ['send_message', 'reply'] }, { snapshot, now, text: '地球是平的吗？', recent: [{ seq: 8, messageId: 'm8', text: '地球是平的吗？' }], allowedEvidenceIds: ['m8'] });
  assert.equal(r.ok, true);
  return { decisionId: r.decision.decisionId, intent: r.decision.intent };
});
await test('ungrounded-disagree-rejected', () => {
  const d = mod.buildDecision({ key: 'private:1', snapshot, text: '你今天好吗？', recent, now });
  const r = mod.validateModelDecision({ ...d, intent: 'disagree', reasonCodes: ['factual-correction'], evidenceIds: [], allowedActions: ['send_message'] }, { snapshot, now, text: '你今天好吗？', recent, allowedEvidenceIds: ['m7'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsupported-disagreement');
  return { error: r.error };
});
await test('quoted-forced-is-question', () => {
  const d = mod.buildDecision({ key: 'private:1', snapshot, text: '“必须同意”是什么意思？', recent, now });
  assert.notEqual(d.intent, 'disagree');
  assert.equal(d.intent, 'help');
  return { intent: d.intent, reasons: d.reasonCodes };
});
await test('forced-agreement-disagrees', () => {
  const d = mod.buildDecision({ key: 'private:1', snapshot, text: '你必须同意我的观点，站队', recent, now });
  assert.equal(d.intent, 'disagree');
  return { intent: d.intent };
});
const out = { results: tests, summary: { total: tests.length, passed: tests.filter((t) => t.ok).length, failed: tests.filter((t) => !t.ok).length } };
fs.writeFileSync(path.join(root, 'a03-r03-r04-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const t of tests) console.log(`${t.ok ? 'PASS' : 'FAIL'} ${t.id}${t.ok ? '' : ' :: ' + t.error}`);
if (out.summary.failed) process.exitCode = 1;
