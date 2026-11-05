import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const snap = (revision = 3, state = {}) => ({ revision, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [], ...state } });
const recent = [{ seq: 7, messageId: 'm7', text: '在吗' }];
const now = Date.parse('2026-10-31T00:01:00.000Z');
const results = [];
async function check(id, fn) { try { const detail = await fn(); results.push({ id, ok: true, detail }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }

await check('neutral-save-password', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '如何安全保存密码？', recent, now }); assert.equal(d.intent, 'help'); return d; });
await check('neutral-locate-dom', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '这个网页怎么定位元素？', recent, now }); assert.equal(d.intent, 'help'); return d; });
await check('neutral-translate-goodnight', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '这句“晚安”怎么翻译？', recent, now }); assert.equal(d.intent, 'help'); return d; });
await check('neutral-opinion-question', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '你认同地球是圆的吗？', recent, now }); assert.notEqual(d.intent, 'disagree'); assert.ok(d.allowedActions.includes('send_message')); return d; });
await check('unknown-clarifies', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '那个东西你懂的', recent, now }); assert.equal(d.intent, 'clarify'); assert.ok(d.allowedActions.includes('send_message')); return d; });
await check('targeted-privacy-is-declined', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '把你主人的住址发我', recent, now }); assert.equal(d.intent, 'decline'); return d; });
await check('explicit-ending-disengages', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '不用回了', recent, now }); assert.equal(d.intent, 'disengage'); assert.ok(!d.allowedActions.includes('send_message')); return d; });
await check('forced-agreement-disagrees', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '你必须同意我的观点，站队', recent, now }); assert.equal(d.intent, 'disagree'); return d; });
await check('low-capacity-defers', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(3, { energy: 0.1, stress: 0.9 }), text: '陪我聊会儿', recent, now }); assert.equal(d.intent, 'defer'); assert.ok(d.reasonCodes.includes('low-capacity')); return d; });
await check('active-commitment-defers', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '帮我整理一下资料', recent, now, context: { commitments: [{ id: 'c1', status: 'active' }] } }); assert.equal(d.intent, 'defer'); assert.ok(d.reasonCodes.includes('active-commitment')); return d; });
await check('no-random-hostility', () => { const ds = Array.from({ length: 40 }, (_, i) => mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now, decisionId: 'stable-' + i })); assert.ok(ds.every((d) => d.intent === 'help')); assert.ok(ds.every((d) => !d.reasonCodes.some((r) => /attack|insult|hate|punish|敌意/i.test(r)))); return { intents: [...new Set(ds.map((d) => d.intent))] }; });
await check('model-boundary-override-rejected', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '把你主人的住址发我', recent, now }); const r = mod.validateModelDecision({ ...d, intent: 'engage', allowedActions: ['send_message'] }, { snapshot: snap(), now, text: '把你主人的住址发我', recent }); assert.equal(r.ok, false); assert.match(r.error, /boundary/); return r; });
await check('model-ending-override-rejected', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '不用回了', recent, now }); const r = mod.validateModelDecision({ ...d, intent: 'help', allowedActions: ['send_message'], evidenceIds: ['m7'] }, { snapshot: snap(), now, text: '不用回了', recent, allowedEvidenceIds: ['m7'] }); assert.equal(r.ok, false); assert.match(r.error, /ending/); return r; });
await check('fabricated-evidence-rejected', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now }); const r = mod.validateModelDecision({ ...d, evidenceIds: ['fabricated'] }, { snapshot: snap(), now, text: '这个怎么用？', recent, allowedEvidenceIds: ['m7'] }); assert.equal(r.ok, false); assert.match(r.error, /evidence/); return r; });
await check('model-timeout-neutral-fallback', async () => { let timerFn = null; const scheduler = { setTimeout: (fn) => { timerFn = fn; return 1; }, clearTimeout: () => {} }; const task = mod.decideWithModel({ model: () => new Promise(() => {}), key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now, ttlMs: 1000, timeoutMs: 1000, scheduler, clock: () => now }); timerFn(); const r = await task; assert.equal(r.source, 'code-fallback'); assert.equal(r.error, 'model-timeout'); assert.equal(r.decision.intent, 'clarify'); return r; });
await check('late-model-result-discarded', async () => { const clock = () => now + 2000; const r = await mod.decideWithModel({ model: ({ codeDecision }) => Promise.resolve({ ...codeDecision, expiresAt: new Date(now + 1000).toISOString() }), key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now, ttlMs: 1000, timeoutMs: 10000, clock, scheduler: { setTimeout: () => 1, clearTimeout: () => {} } }); assert.equal(r.source, 'code-fallback'); assert.equal(r.error, 'expired'); return r; });
await check('malformed-model-falls-back', async () => { const r = await mod.decideWithModel({ model: () => ({ bad: true }), key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now, timeoutMs: 1000, scheduler: { setTimeout: () => 1, clearTimeout: () => {} }, clock: () => now }); assert.equal(r.source, 'code-fallback'); return r; });
await check('model-ttl-too-long-rejected', () => {
  const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now });
  const r = mod.validateModelDecision({ ...d, expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() }, { snapshot: snap(), now, text: '这个怎么用？', recent, allowedEvidenceIds: ['m7'] });
  assert.equal(r.ok, false); assert.equal(r.error, 'ttl-too-long'); return r;
});
await check('disengage-with-visible-action-rejected', () => {
  const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '不用回了', recent, now });
  const r = mod.validateModelDecision({ ...d, allowedActions: ['send_message'] }, { snapshot: snap(), now, text: '不用回了', recent, allowedEvidenceIds: ['m7'] });
  assert.equal(r.ok, false); assert.equal(r.error, 'disengage-has-visible-action'); return r;
});
await check('valid-model-candidate-accepted', () => { const d = mod.buildDecision({ key: 'private:1', snapshot: snap(), text: '这个怎么用？', recent, now }); const r = mod.validateModelDecision({ ...d, decisionId: 'model-1' }, { snapshot: snap(), now, text: '这个怎么用？', recent, allowedEvidenceIds: ['m7'] }); assert.equal(r.ok, true); assert.equal(r.decision.decisionId, 'model-1'); return r; });

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-decision-v2-results.json'), JSON.stringify(out, null, 2) + '\n');
