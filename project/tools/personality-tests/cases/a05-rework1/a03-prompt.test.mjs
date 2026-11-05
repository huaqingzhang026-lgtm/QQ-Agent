import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { CANDIDATE_ROOT: C } = await import('./candidate-root.mjs');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const bridge = read(path.join(C, 'qq-bridge/src/bridge.js'));
const cfg = JSON.parse(read(path.join(C, 'qq-bridge/config.json')));
const mod = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-decision.mjs')).href);
const em = await import(pathToFileURL(path.join(C, 'qq-bridge/src/personality-execution.mjs')).href);
const now = Date.parse('2026-10-31T00:00:00.000Z');
const snapshot = { revision: 3, state: { valence: 0, energy: 0.6, stress: 0.2, attention: 0.7, updatedAt: '2026-10-31T00:00:00.000Z', causeEventIds: [] } };
const decision = mod.buildDecision({ key: 'group:synthetic', snapshot, text: '这个怎么用？', now });
const execution = em.createExecutionContext({ key: 'group:synthetic', decision, sessionId: 'sess', epoch: 2, seq: 1, now, ttlMs: 360000 });
const st = { agentToken: 'synthetic-token', unread: [], recentMessages: [], sendTimes: [], wakeConfig: { mode: 'active' }, activeDecision: decision, activeExecution: execution, activeDecisionSeq: 1, decisionEpoch: 2, annoyance: {} };
const ctx = { cfg, path, readRoleState: () => ({ role: 'synthetic' }), selfIdentityTextV2: () => '', getSocialV2State: () => st,
  buildMemoryBrief: () => '', readEvolutionPrompt: () => '', layeredMemoryBrief: () => '', dailyLifeBrief: () => '', formatMemoryV2: () => '', formatParticipationV2: () => '',
  buildStickerStrategyHint: () => '', buildStickerContext: () => '', stickerEntries: [], replyTimingV2: () => ({ quietMs: 0, remainingQuietMs: 0 }), looksLikeUnfinished: () => false,
  formatInitialPromptV2: () => '', mintScopeToken: () => '', MEMORY_SCOPE_SECRET: 'synthetic', getPerson: () => null, peopleDb: {}, formatPersonLine: () => '',
  formatCrossGroupDigest: () => '', buildCrossGroupDigest: () => ({}), socialV2: { conversations: new Map() }, groupInfoCache: new Map(), formatGroupInfoV2: () => '',
  buildRecentRecap: () => '', readJsonSafe: () => ({}), STATE_DIR: 'synthetic', takeRotationRecap: () => '', selfFixActive: () => false,
  ownerSendGrants: new Map(), biliMemoryLine: () => '', skillsIndexLine: () => '', groupStyleLine: () => '', topicHooksLine: () => '', decisionPromptLine: mod.decisionPromptLine, executionPromptLine: em.executionPromptLine };
const start = bridge.indexOf('function buildWakePromptV2(key, reason) {');
const end = bridge.indexOf('function buildWakeReminderPromptV2(', start);
assert.ok(start >= 0 && end > start, 'wake function markers');
const buildWake = vm.runInNewContext('(' + bridge.slice(start, end).trim() + ')', ctx, { timeout: 3000 });
const prompt = buildWake('group:synthetic', 'at');
const results = [];
function check(id, fn) { try { results.push({ id, ok: true, detail: fn() }); } catch (e) { results.push({ id, ok: false, error: String(e?.stack ?? e) }); } }
check('prompt-includes-decision', () => { assert.match(prompt, /【本轮决策】/); assert.match(prompt, /send_message/); return { hasDecision: true }; });
check('prompt-includes-execution-credential', () => { assert.match(prompt, /【本轮执行凭证】/); assert.ok(prompt.includes(execution.executionId)); return { executionId: execution.executionId.slice(0, 6) }; });
check('prompt-no-internal-reasoning-leak', () => { assert.ok(!/逐步推理|思维链|chain-of-thought/i.test(prompt)); return { clean: true }; });
const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
if (process.env.A00_DATA_ROOT) fs.writeFileSync(path.join(process.env.A00_DATA_ROOT, 'a03-prompt-results.json'), JSON.stringify(out, null, 2) + '\n');
