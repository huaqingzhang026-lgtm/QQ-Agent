// A05-rework1 F06：回归必须读取当前候选；禁止历史测试读旧候选根。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const forbidden = ['deepseek-harness','personality-rework','candidate'].join('/');

test('candidate-root-resolves-to-current-project', () => {
  assert.equal(path.basename(C), 'project');
  assert.ok(fs.existsSync(path.join(C, 'qq-bridge/src/bridge.js')));
  return { candidateRoot: C };
});

test('current-candidate-tests-do-not-reference-old-candidate', () => {
  const dir = path.join(C, 'tools/personality-tests/cases/a05-rework1');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (text.includes(forbidden)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
  return { scanned: fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).length, offenders };
});

test('bridge-source-reads-current-candidate', async () => {
  const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/commitments.mjs')).href);
  assert.equal(typeof mod.proposeCommitment, 'function');
  return { commitmentsModule: true };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r1-candidate-root-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
