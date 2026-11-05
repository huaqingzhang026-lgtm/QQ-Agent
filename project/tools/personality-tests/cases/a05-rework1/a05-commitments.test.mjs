// A05 commitment lifecycle: activation requires send confirmation; completion requires evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/commitments.mjs')).href);
const { openMemory } = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const at = Date.parse('2026-11-05T00:00:00.000Z');
const tmpDir = fs.mkdtempSync(path.join(root, 'a05-commitments-'));
const db = openMemory(path.join(tmpDir, 'db.sqlite'));

test('propose-requires-evidence-and-dedupes', () => {
  const bad = mod.proposeCommitment({ scope: 'private:1', actorId: '11', text: '明天给你简历', evidenceRefs: [] });
  assert.equal(bad.ok, false);
  const one = mod.proposeCommitment({ scope: 'private:1', actorId: '11', text: '明天给你简历', evidenceRefs: ['m1'], createdAt: at });
  const two = mod.proposeCommitment({ scope: 'private:1', actorId: '11', text: '明天给你简历', evidenceRefs: ['m2'], createdAt: at + 1 });
  assert.equal(one.ok, true);
  assert.equal(one.commitment.status, 'proposed');
  assert.equal(two.duplicate, true);
  return { id: one.commitment.id, duplicate: two.duplicate };
});

test('activation-requires-send-confirmation-and-is-idempotent', () => {
  const list = mod.listCommitments({ scopes: ['private:1'], statuses: ['proposed'] });
  assert.equal(list.length, 1);
  const r = mod.activateCommitment({ id: list[0].id, evidenceRefs: ['send-confirm:1'], activatedAt: at + 10 });
  assert.equal(r.applied, true);
  assert.equal(r.commitment.status, 'active');
  const again = mod.activateCommitment({ id: list[0].id, evidenceRefs: ['send-confirm:2'], activatedAt: at + 20 });
  assert.equal(again.applied, false);
  assert.equal(again.duplicate, true);
  return { status: r.commitment.status, duplicate: again.duplicate };
});

test('completion-requires-evidence', () => {
  const list = mod.listCommitments({ scopes: ['private:1'], statuses: ['active'] });
  const id = list[0].id;
  const noEvidence = mod.completeCommitment({ id, evidenceRefs: [] });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.code, 'completion-evidence-required');
  const ok = mod.completeCommitment({ id, evidenceRefs: ['tool-result:disk-cleanup'], completedAt: at + 30 });
  assert.equal(ok.applied, true);
  assert.equal(ok.commitment.status, 'fulfilled');
  assert.deepEqual(JSON.parse(ok.commitment.evidence_json), ['m1', 'send-confirm:1', 'tool-result:disk-cleanup']);
  return { status: ok.commitment.status, evidence: JSON.parse(ok.commitment.evidence_json) };
});

test('withdraw-and-reschedule-keep-record', () => {
  const p = mod.proposeCommitment({ scope: 'private:1', actorId: '11', text: '周末整理笔记', evidenceRefs: ['m2'], createdAt: at });
  mod.activateCommitment({ id: p.commitment.id, evidenceRefs: ['send-confirm:2'] });
  const r = mod.rescheduleCommitment({ id: p.commitment.id, dueAt: at + 86400000, reason: 'user-asked' });
  const w = mod.withdrawCommitment({ id: p.commitment.id, reason: 'no-longer-needed' });
  assert.equal(r.applied, true);
  assert.equal(w.applied, true);
  assert.equal(w.commitment.status, 'withdrawn');
  return { status: w.commitment.status };
});

test('scope-filter-prevents-cross-scope-prompting', () => {
  const p = mod.proposeCommitment({ scope: 'private:1', actorId: '11', text: '私聊承诺：帮你整理照片', evidenceRefs: ['m3'], createdAt: at });
  mod.activateCommitment({ id: p.commitment.id, evidenceRefs: ['send-confirm:3'] });
  const groupList = mod.listCommitments({ scopes: ['group:1'], statuses: ['active'] });
  assert.equal(groupList.some((x) => x.text.includes('私聊承诺')), false);
  const line = mod.commitmentPromptLine(groupList);
  assert.equal(line.includes('私聊承诺'), false);
  return { groupList: groupList.length };
});

test('outgoing-activation-only-for-matching-text', () => {
  const p = mod.proposeCommitment({ scope: 'private:1', actorId: '11', text: '我明天把面试笔记整理好', evidenceRefs: ['m4'], createdAt: at });
  const none = mod.activateCommitmentsForSentText({ scope: 'private:1', text: '今天天气不错', activatedAt: at + 40 });
  assert.equal(none.activated, 0);
  const yes = mod.activateCommitmentsForSentText({ scope: 'private:1', text: '我明天把面试笔记整理好，稍后发你', activatedAt: at + 50 });
  assert.equal(yes.activated, 1);
  const row = openMemory().prepare('SELECT status FROM commitments WHERE id=?').get(p.commitment.id);
  assert.equal(row.status, 'active');
  return { none: none.activated, yes: yes.activated, status: row.status };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05-commitments-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
