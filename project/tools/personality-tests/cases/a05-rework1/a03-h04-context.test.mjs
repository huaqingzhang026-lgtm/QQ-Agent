// A03-rework3 H04：常规多轮交流保留已读历史与自身回复。
// 真实 attachWakeDecision + 真实 HTTP provider 请求构造；fetch 为受控替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeWorld, mod, now } from './bridge-fixture.mjs';

const root = process.env.A00_DATA_ROOT;
if (!root) throw Error('A00_DATA_ROOT required');
fs.mkdirSync(root, { recursive: true });
const results = [];
async function test(id, fn) {
  try { results.push({ id, ok: true, detail: await fn() }); }
  catch (error) { results.push({ id, ok: false, error: String(error?.stack ?? error) }); }
}
function worldWithHttp(candidateFactory) {
  const w = makeWorld();
  w.ctx.cfg.socialV2.personalityV2.provider = { baseUrl: 'http://synthetic.invalid', model: 'synthetic' };
  let body = null;
  Object.assign(w.ctx, {
    AbortSignal,
    fetch: async (_url, opts) => {
      body = JSON.parse(opts.body);
      const structured = JSON.parse(String(body.messages[1].content).split('结构化上下文：')[1]);
      const candidate = candidateFactory ? candidateFactory(structured, w) : mod.buildDecision({ key: 'private:1', snapshot: w.getSnapshot(), text: structured.text, recent: structured.recent, now });
      return { ok: true, json: async () => ({ decision: candidate }) };
    },
  });
  return { w, getBody: () => body };
}
function history(count, prefix = 'h') {
  return Array.from({ length: count }, (_, i) => ({ messageId: `${prefix}-${i}`, seq: i + 1, userId: '2', text: `${prefix} 第 ${i} 条` }));
}

await test('http-body-has-read-user-self-and-current-unread', async () => {
  const h = worldWithHttp();
  const st = h.w.st;
  st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '你认为呢？' }];
  st.lastUnreadSeq = 7;
  st.recentMessages = [
    { messageId: 'history-5', seq: 5, userId: '2', text: '我之前说的安排是周日去爬山。' },
    { messageId: 'history-6', seq: 6, isSelf: true, text: '我比较喜欢室内活动，想改个安排。' },
    ...st.unread,
  ];
  await h.w.ctx.attachWakeDecision('private:1', 'at');
  const body = h.getBody();
  const structured = JSON.parse(String(body.messages[1].content).split('结构化上下文：')[1]);
  const ids = structured.recent.map((m) => m.messageId);
  assert.deepEqual(ids, ['history-5', 'history-6', 'm7']);
  assert.equal(structured.text, '你认为呢？');
  assert.equal(structured.recent[1].isSelf, true);
  assert.deepEqual(structured.evidenceIds, ids);
  assert.equal(structured.commitments.status, 'unknown');
  assert.equal(structured.activity.status, 'unknown');
  return { ids, text: structured.text, evidence: structured.evidenceIds, unknowns: true };
});

await test('overlapping-recent-and-unread-dedup', async () => {
  const h = worldWithHttp();
  const st = h.w.st;
  const m7 = { messageId: 'm7', seq: 7, userId: '2', text: '你认为呢？' };
  st.unread = [m7];
  st.lastUnreadSeq = 7;
  st.recentMessages = [{ messageId: 'h5', seq: 5, userId: '2', text: '前文' }, m7, { ...m7 }];
  await h.w.ctx.attachWakeDecision('private:1', 'at');
  const structured = JSON.parse(String(h.getBody().messages[1].content).split('结构化上下文：')[1]);
  const ids = structured.recent.map((m) => m.messageId);
  assert.equal(ids.filter((x) => x === 'm7').length, 1);
  assert.deepEqual(ids, ['h5', 'm7']);
  return { ids };
});

await test('context-is-bounded-not-unlimited', async () => {
  const h = worldWithHttp();
  const st = h.w.st;
  st.recentMessages = history(30, 'r');
  st.unread = Array.from({ length: 10 }, (_, i) => ({ messageId: `u-${i}`, seq: 31 + i, userId: '2', text: `未读 ${i}` }));
  st.lastUnreadSeq = 40;
  await h.w.ctx.attachWakeDecision('private:1', 'at');
  const structured = JSON.parse(String(h.getBody().messages[1].content).split('结构化上下文：')[1]);
  assert.ok(structured.recent.length <= 12);
  assert.equal(structured.recent.at(-1).messageId, 'u-9');
  assert.equal(structured.evidenceIds.length, structured.recent.length);
  return { recent: structured.recent.length, last: structured.recent.at(-1).messageId };
});

await test('conversation-isolation', async () => {
  const h = worldWithHttp();
  const privateSt = h.w.st;
  privateSt.recentMessages = [{ messageId: 'p-1', seq: 1, userId: '2', text: '私聊前文' }];
  const groupSt = {
    lastUnreadSeq: 2, activeDecisionSeq: 2, decisionEpoch: 1, activeDecision: null, activeExecution: null, activeExecutionId: '',
    sendTimes: [], recentMessages: [{ messageId: 'g-1', seq: 1, userId: '3', sender: '群友A', text: '群聊前文' }], unread: [{ messageId: 'g-2', seq: 2, userId: '3', sender: '群友A', text: '群里问' }], wakeConfig: {},
  };
  h.w.ctx.socialV2.conversations.set('group:2', groupSt);
  h.w.ctx.getSocialV2State = (key) => (key === 'group:2' ? groupSt : privateSt);
  await h.w.ctx.attachWakeDecision('group:2', 'at');
  const structured = JSON.parse(String(h.getBody().messages[1].content).split('结构化上下文：')[1]);
  const ids = structured.recent.map((m) => m.messageId);
  assert.deepEqual(ids, ['g-1', 'g-2']);
  assert.equal(structured.recent[0].sender, '群友A');
  assert.equal(JSON.stringify(structured).includes('p-1'), false);
  return { ids, privateLeak: false };
});

await test('history-evidence-accepted-when-displayed', async () => {
  const h = worldWithHttp((structured) => {
    const base = mod.buildDecision({ key: 'private:1', snapshot: h.w.getSnapshot(), text: structured.text, recent: structured.recent, now });
    return { ...base, decisionId: 'model-history-cite', evidenceIds: ['history-5'], intent: 'help', allowedActions: ['send_message', 'reply'] };
  });
  const st = h.w.st;
  st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '你觉得呢？' }];
  st.lastUnreadSeq = 7;
  st.recentMessages = [{ messageId: 'history-5', seq: 5, userId: '2', text: '周日去爬山' }, ...st.unread];
  const decision = await h.w.ctx.attachWakeDecision('private:1', 'at');
  assert.ok(decision);
  assert.equal(decision.decisionId, 'model-history-cite');
  assert.deepEqual(decision.evidenceIds, ['history-5']);
  return { accepted: true, evidenceIds: decision.evidenceIds };
});

await test('unshown-evidence-is-rejected', async () => {
  const h = worldWithHttp((structured) => {
    const base = mod.buildDecision({ key: 'private:1', snapshot: h.w.getSnapshot(), text: structured.text, recent: structured.recent, now });
    return { ...base, decisionId: 'model-fabricated', evidenceIds: ['not-shown'], intent: 'help', allowedActions: ['send_message', 'reply'] };
  });
  const st = h.w.st;
  st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '你觉得呢？' }];
  st.lastUnreadSeq = 7;
  st.recentMessages = [{ messageId: 'history-5', seq: 5, userId: '2', text: '周日去爬山' }, ...st.unread];
  const decision = await h.w.ctx.attachWakeDecision('private:1', 'at');
  assert.ok(decision);
  assert.notEqual(decision.decisionId, 'model-fabricated');
  assert.equal(decision.evidenceIds.includes('not-shown'), false);
  assert.equal(decision.reasonCodes.includes('neutral-fallback'), true);
  return { rejected: true, fallbackReasons: decision.reasonCodes };
});

await test('same-question-different-prefix-produces-different-facts', async () => {
  const a = worldWithHttp();
  a.w.st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '你认为呢？' }];
  a.w.st.lastUnreadSeq = 7;
  a.w.st.recentMessages = [{ messageId: 'a-5', seq: 5, userId: '2', text: '我打算周日去爬山。' }];
  await a.w.ctx.attachWakeDecision('private:1', 'at');
  const first = JSON.parse(String(a.getBody().messages[1].content).split('结构化上下文：')[1]);
  const b = worldWithHttp();
  b.w.st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '你认为呢？' }];
  b.w.st.lastUnreadSeq = 7;
  b.w.st.recentMessages = [{ messageId: 'b-5', seq: 5, userId: '2', text: '我打算周日在家看番。' }];
  await b.w.ctx.attachWakeDecision('private:1', 'at');
  const second = JSON.parse(String(b.getBody().messages[1].content).split('结构化上下文：')[1]);
  assert.equal(first.text, second.text);
  assert.notDeepEqual(first.recent.map((m) => m.text), second.recent.map((m) => m.text));
  return { sameQuestion: true, firstPrefix: first.recent[0].text, secondPrefix: second.recent[0].text };
});

await test('timer-wake-does-not-treat-history-ending-as-current-request', async () => {
  const h = worldWithHttp();
  const st = h.w.st;
  st.unread = [];
  st.lastUnreadSeq = 6;
  st.recentMessages = [
    { messageId: 'e-5', seq: 5, userId: '2', text: '晚安' },
    { messageId: 'e-6', seq: 6, isSelf: true, text: '晚安，做个好梦' },
  ];
  await h.w.ctx.attachWakeDecision('private:1', 'timeout');
  const structured = JSON.parse(String(h.getBody().messages[1].content).split('结构化上下文：')[1]);
  assert.equal(structured.text, '');
  assert.equal(structured.recent.length, 2);
  assert.equal(structured.recent[1].isSelf, true);
  return { currentRequest: structured.text, historyKept: structured.recent.length };
});

await test('self-message-with-only-time-is-kept', async () => {
  const h = worldWithHttp();
  const st = h.w.st;
  st.unread = [{ messageId: 'm7', seq: 7, userId: '2', text: '那你呢？', time: 3000 }];
  st.lastUnreadSeq = 7;
  st.recentMessages = [
    { messageId: 'h5', seq: 5, userId: '2', text: '周日去爬山吗？', time: 1000 },
    { isSelf: true, sender: '我', text: '我更想在家看番。', time: 2000 },
    ...st.unread,
  ];
  await h.w.ctx.attachWakeDecision('private:1', 'at');
  const structured = JSON.parse(String(h.getBody().messages[1].content).split('结构化上下文：')[1]);
  assert.deepEqual(structured.recent.map((m) => m.text), ['周日去爬山吗？', '我更想在家看番。', '那你呢？']);
  assert.equal(structured.recent[1].isSelf, true);
  return { keptSelf: true, order: structured.recent.map((m) => m.isSelf) };
});

const out = { results, summary: { total: results.length, passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length } };
fs.writeFileSync(path.join(root, 'a03-h04-context-results.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.ok ? '' : ' :: ' + r.error}`);
if (out.summary.failed) process.exitCode = 1;
