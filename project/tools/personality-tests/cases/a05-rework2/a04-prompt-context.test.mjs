// A04 关系进入真实决策上下文与唤醒提示词；不是只存在于纯 reducer。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const { makeWorld, mod } = await import(pathToFileURL(path.join(import.meta.dirname || '.', 'bridge-fixture.mjs')).href);
const affect = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-affect.mjs')).href);
const source = fs.readFileSync(path.join(C, 'qq-bridge/src/bridge.js'), 'utf8');
const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); }
}
const now = Date.parse('2026-11-04T00:00:00.000Z');
const iso = new Date(now).toISOString();
const relationship = { trust: 0.42, closeness: 0.28, tension: 0.06, familiarity: 0.35, updatedAt: iso, causeEventIds: ['evt-private'] };

await test('decision-provider-body-includes-relationship', async () => {
  const w = makeWorld();
  w.ctx.cfg.socialV2.personalityV2.provider = { baseUrl: 'http://synthetic.invalid', model: 'synthetic' };
  w.st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '你觉得呢？' }];
  w.st.lastUnreadSeq = 7;
  w.setSnapshot({ revision: 3, state: w.getSnapshot().state, persona: null, relationships: { '2': relationship } });
  let body;
  Object.assign(w.ctx, {
    AbortSignal,
    fetch: async (_url, opts) => {
      body = JSON.parse(opts.body);
      const structured = JSON.parse(String(body.messages[1].content).split('结构化上下文：')[1]);
      return { ok: true, json: async () => ({ decision: mod.buildDecision({ key: 'private:1', snapshot: w.getSnapshot(), text: structured.text, recent: structured.recent, now }) }) };
    },
  });
  await w.ctx.attachWakeDecision('private:1', 'at');
  const structured = JSON.parse(String(body.messages[1].content).split('结构化上下文：')[1]);
  assert.equal(structured.relationship.trust, 0.42);
  assert.equal(structured.relationship.closeness, 0.28);
  assert.equal(structured.relationship.tension, 0.06);
  assert.equal('causeEventIds' in structured.relationship, false, 'private evidence IDs must not enter group/provider context');
  return { relationship: structured.relationship };
});

await test('wake-prompt-includes-relationship-line', async () => {
  const ctx = {
    cfg: { socialV2: {} }, path,
    readRoleState: () => ({ role: 'synthetic' }), selfIdentityTextV2: () => '', getSocialV2State: () => ({ agentToken: 't', unread: [], recentMessages: [{ userId: '2', sender: '小王', isSelf: false, text: '在吗' }], sendTimes: [], wakeConfig: {}, activeDecision: null, activeExecution: null, annoyance: {} }),
    buildMemoryBrief: () => '', readEvolutionPrompt: () => '', layeredMemoryBrief: () => '', dailyLifeBrief: () => '', formatMemoryV2: () => '', formatParticipationV2: () => '',
    buildStickerStrategyHint: () => '', buildStickerContext: () => '', stickerEntries: [], replyTimingV2: () => ({ quietMs: 0, remainingQuietMs: 0 }), looksLikeUnfinished: () => false,
    formatInitialPromptV2: () => '', mintScopeToken: () => '', MEMORY_SCOPE_SECRET: 's', getPerson: () => null, peopleDb: {}, formatPersonLine: () => '',
    formatCrossGroupDigest: () => '', buildCrossGroupDigest: () => ({}), socialV2: { conversations: new Map() }, groupInfoCache: new Map(), formatGroupInfoV2: () => '',
    buildRecentRecap: () => '', readJsonSafe: () => ({}), STATE_DIR: 'synthetic', takeRotationRecap: () => '', selfFixActive: () => false,
    ownerSendGrants: new Map(), biliMemoryLine: () => '', skillsIndexLine: () => '', groupStyleLine: () => '', topicHooksLine: () => '',
    decisionPromptLine: mod.decisionPromptLine, executionPromptLine: () => '',
    relationshipFor: () => relationship, relationshipPromptLine: affect.relationshipPromptLine,
  };
  const start = source.indexOf('function buildWakePromptV2(key, reason) {');
  const end = source.indexOf('function buildWakeReminderPromptV2(', start);
  const buildWake = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', ctx, { timeout: 3000 });
  const prompt = buildWake('group:synthetic', 'at');
  assert.match(prompt, /【关系状态】/);
  assert.match(prompt, /信任 42/);
  assert.match(prompt, /不是本轮指令/);
  assert.equal(prompt.includes('evt-private'), false);
  return { hasRelationship: true };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a04-prompt-context-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
