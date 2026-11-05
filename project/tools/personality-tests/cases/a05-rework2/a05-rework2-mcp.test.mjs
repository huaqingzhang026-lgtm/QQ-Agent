// A05-rework2 R1-F03/F04：MCP 修改授权、可信时钟与 JSON-RPC 响应。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const commitmentsMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/commitments.mjs')).href);
const scopeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-scope.js')).href);
const storeMod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/memory-store.mjs')).href);
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, 'a05r2-mcp-'));
const db = storeMod.openMemory(path.join(tmp, 'memory.sqlite'));
const results = [];
function test(id, fn) {
  try { results.push({ id, ok: true, detail: fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const base = Date.parse('2026-11-05T00:00:00.000Z');
const TTL = scopeMod.TOKEN_TTL_MS;
const SECRET = 'f'.repeat(64);

let handler = null;
let responses = [];
function makeHandler() {
  const server = fs.readFileSync(path.join(C, 'memory-mcp/server.mjs'), 'utf8');
  responses = [];
  const ctx = vm.createContext({
    readline: { createInterface: () => ({ on: (_e, fn) => { handler = fn; } }) },
    process: { stdin: {} },
    send: (x) => responses.push(x),
    commitmentsMod,
    verifyScopeToken: scopeMod.verifyScopeToken,
    allowedScopes: scopeMod.allowedScopes,
    isRecordVisible: scopeMod.isRecordVisible,
    SCOPE_SECRET: SECRET,
    SCOPE_SHARE_GROUPS: [],
  });
  vm.runInContext(server.slice(server.indexOf('readline.createInterface(')), ctx);
  assert.equal(typeof handler, 'function');
  return handler;
}
handler = makeHandler();

function callTool(id, name, args = {}) {
  handler(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
  return responses.at(-1);
}
function responseText(response) {
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}
function createActive(id, scope = 'private:22') {
  const r = commitmentsMod.proposeCommitment({
    id, scope, actorId: 'self', targetId: '22', text: `任务-${id}`, messageText: `交付-${id}`,
    dueAt: base + 86400000, source: 'decision', sourceRef: `dec-${id}`, decisionId: `dec-${id}`,
    requestRef: `message:req-${id}`, requestMessageId: `req-${id}`, executionId: `exec-${id}`,
    completionType: 'deliver_message', completionCondition: { messageText: `交付-${id}` }, createdAt: base,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const a = commitmentsMod.activateCommitment({
    id, evidence: {
      kind: 'send', success: true, ref: `send:${id}`, transportRef: `send:${id}`,
      messageId: `sent-${id}`, executionId: `exec-${id}`, decisionId: `dec-${id}`,
      messageText: `交付-${id}`, at: base + 1,
    },
  });
  assert.equal(a.ok, true, JSON.stringify(a));
  return commitmentsMod.getCommitment({ id });
}
function snapshot(row) {
  const fresh = commitmentsMod.getCommitment({ id: row.id });
  return { status: fresh.status, evidence_json: fresh.evidence_json, due_at: fresh.due_at, reason: fresh.reason, fulfillment_ref: fresh.fulfillment_ref };
}

test('external-expire-tool-is-removed', () => {
  const tools = JSON.parse(JSON.stringify((() => {
    const source = fs.readFileSync(path.join(C, 'memory-mcp/server.mjs'), 'utf8');
    return source.includes("name: 'commitment_expire'");
  })()));
  assert.equal(tools, false);
  const response = callTool(1, 'commitment_expire', { now: base + 365 * 86400000 });
  const parsed = responseText(response);
  assert.equal(parsed?.ok, false);
  return { response: parsed };
});

test('future-now-cannot-expire-cross-scope', () => {
  const row = createActive('future-private');
  const before = snapshot(row);
  const response = callTool(2, 'commitment_expire', { now: base + 365 * 86400000 });
  const parsed = responseText(response);
  assert.equal(parsed?.ok, false);
  assert.deepEqual(snapshot(row), before);
  return { before, response: parsed };
});

test('missing-token-rejects-withdraw-and-reschedule', () => {
  const row = createActive('missing-token');
  const before = snapshot(row);
  const w = responseText(callTool(3, 'commitment_withdraw', { id: row.id }));
  const r = responseText(callTool(4, 'commitment_reschedule', { id: row.id, dueAt: base + 2 * 86400000 }));
  assert.equal(w?.ok, false);
  assert.equal(r?.ok, false);
  assert.deepEqual(snapshot(row), before);
  return { before, withdraw: w, reschedule: r };
});

test('invalid-token-rejects-without-side-effect', () => {
  const row = createActive('invalid-token');
  const before = snapshot(row);
  const w = responseText(callTool(5, 'commitment_withdraw', { id: row.id, scopeToken: 'bad.token' }));
  const r = responseText(callTool(6, 'commitment_reschedule', { id: row.id, dueAt: base + 86400000, scopeToken: 'bad.token' }));
  assert.equal(w?.ok, false);
  assert.equal(r?.ok, false);
  assert.deepEqual(snapshot(row), before);
  return { before, withdraw: w, reschedule: r };
});

test('expired-token-rejects-without-side-effect', () => {
  const row = createActive('expired-token');
  const before = snapshot(row);
  const oldToken = scopeMod.mintScopeToken(SECRET, row.scope, base - 2 * TTL);
  const w = responseText(callTool(7, 'commitment_withdraw', { id: row.id, scopeToken: oldToken }));
  const r = responseText(callTool(8, 'commitment_reschedule', { id: row.id, dueAt: base + 86400000, scopeToken: oldToken }));
  assert.equal(w?.ok, false);
  assert.equal(r?.ok, false);
  assert.deepEqual(snapshot(row), before);
  return { before, withdraw: w, reschedule: r };
});

test('group-token-cannot-mutate-private-scope', () => {
  const row = createActive('private-target');
  const before = snapshot(row);
  const token = scopeMod.mintScopeToken(SECRET, 'group:1', Date.now());
  const w = responseText(callTool(9, 'commitment_withdraw', { id: row.id, scopeToken: token }));
  const r = responseText(callTool(10, 'commitment_reschedule', { id: row.id, dueAt: base + 86400000, scopeToken: token }));
  assert.equal(w?.ok, false);
  assert.equal(r?.ok, false);
  assert.deepEqual(snapshot(row), before);
  return { before, withdraw: w, reschedule: r };
});

test('same-scope-token-can-withdraw-with-valid-response', () => {
  const row = createActive('withdraw-ok');
  const token = scopeMod.mintScopeToken(SECRET, row.scope, Date.now());
  const response = callTool(11, 'commitment_withdraw', { id: row.id, scopeToken: token, reason: 'user-cancelled' });
  const parsed = responseText(response);
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.applied, true);
  assert.equal(parsed?.duplicate, false);
  assert.equal(parsed?.scope, row.scope);
  assert.equal(commitmentsMod.getCommitment({ id: row.id }).status, 'withdrawn');
  return { parsed, status: 'withdrawn' };
});

test('same-scope-token-can-reschedule-with-valid-response', () => {
  const row = createActive('reschedule-ok');
  const token = scopeMod.mintScopeToken(SECRET, row.scope, Date.now());
  const response = callTool(12, 'commitment_reschedule', { id: row.id, scopeToken: token, dueAt: base + 3 * 86400000, reason: 'user-asked' });
  const parsed = responseText(response);
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.applied, true);
  assert.equal(parsed?.scope, row.scope);
  const after = commitmentsMod.getCommitment({ id: row.id });
  assert.equal(after.due_at, base + 3 * 86400000);
  assert.equal(after.status, 'active');
  return { parsed, status: after.status };
});

test('duplicate-withdraw-is-idempotent-and-response-valid', () => {
  const row = createActive('withdraw-duplicate');
  const token = scopeMod.mintScopeToken(SECRET, row.scope, Date.now());
  const first = responseText(callTool(13, 'commitment_withdraw', { id: row.id, scopeToken: token }));
  const second = responseText(callTool(14, 'commitment_withdraw', { id: row.id, scopeToken: token }));
  assert.equal(first?.applied, true);
  assert.equal(second?.applied, false);
  assert.equal(second?.duplicate, true);
  assert.equal(commitmentsMod.getCommitment({ id: row.id }).status, 'withdrawn');
  return { first, second };
});

test('not-found-response-is-valid-and-has-no-side-effect', () => {
  const response = callTool(15, 'commitment_withdraw', { id: 'does-not-exist', scopeToken: scopeMod.mintScopeToken(SECRET, 'private:22', Date.now()) });
  const parsed = responseText(response);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.error, '承诺不存在或当前会话无修改权限');
  return { parsed };
});

test('trusted-server-clock-expires-and-preserves-terminal', () => {
  const active = createActive('clock-expire');
  const fulfilled = createActive('clock-terminal');
  commitmentsMod.completeCommitment({
    id: fulfilled.id,
    evidence: {
      kind: 'tool', success: true, toolName: 'qq-transport', action: 'send_message',
      resultRef: `tool:${fulfilled.id}`, commitmentId: fulfilled.id, scope: fulfilled.scope,
      actualTargetId: fulfilled.target_id, messageText: `交付-${fulfilled.id}`, executionId: 'clock-exec',
    },
  });
  const result = commitmentsMod.expireCommitments({ now: base + 2 * 86400000 });
  assert.ok(result.expired >= 1);
  assert.equal(commitmentsMod.getCommitment({ id: active.id }).status, 'expired');
  assert.equal(commitmentsMod.getCommitment({ id: fulfilled.id }).status, 'fulfilled');
  return { expired: result.expired, active: 'expired', terminal: 'fulfilled' };
});

test('all-commitment-tool-responses-have-text-contract', () => {
  const row = createActive('response-contract');
  const token = scopeMod.mintScopeToken(SECRET, row.scope, Date.now());
  const checks = [
    callTool(16, 'commitment_withdraw', { id: row.id, scopeToken: token }),
    callTool(17, 'commitment_reschedule', { id: row.id, scopeToken: token, dueAt: base + 4 * 86400000 }),
    callTool(18, 'commitment_expire', { now: base + 5 * 86400000 }),
  ];
  for (const response of checks) {
    const text = response?.result?.content?.[0]?.text;
    assert.equal(typeof text, 'string');
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed.ok, 'boolean');
    assert.equal(typeof parsed.applied, 'boolean');
    if (typeof parsed.duplicate !== 'boolean') {
      // commitment_expire 已从外部工具移除；unknown tool 只需返回等价失败契约。
      assert.ok(parsed.code || parsed.error);
    }
    assert.ok(parsed.ok || parsed.code || parsed.error);
  }
  return { checked: checks.length };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a05r2-mcp-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
