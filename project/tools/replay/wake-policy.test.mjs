// 离线回放：唤醒门 v2（wake-policy）的确定性场景。
//
// v2 规则（behavior-spec §2）：
//   · @ / 明确提问 / 拍一拍 → 一律受理；
//   · 定时类（timeout/replyCheck/proactiveCheck/bootstrap）→ 不受随机忽略；
//   · 只有 nameMention/keyword/topicKeywords/probability 抽随机；
//   · 私聊默认必回，privateAlwaysReply=false 时才抽。
//
// 运行：node tools/replay/wake-policy.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideWakeGate, ignoreProbabilityFor, REASON_CODES } from '../../qq-bridge/src/wake-policy.js';

const cfgs = {
  prod: { socialV2: { wake: { ignoreAtMentionProbability: 0.2, ignoreProbability: 0.35 } } },
  off: { socialV2: { wake: { ignoreAtMentionProbability: 0, ignoreProbability: 0 } } },
  missing: {},
  bad: { socialV2: { wake: { ignoreAtMentionProbability: 'x', ignoreProbability: -1 } } },
  full: { socialV2: { wake: { ignoreAtMentionProbability: 1, ignoreProbability: 1 } } },
  privateOn: { socialV2: { wake: { privateAlwaysReply: false, ignoreProbability: 0.5 } } },
  privateOff: { socialV2: { wake: { privateAlwaysReply: true, ignoreProbability: 0.5 } } },
};

const fixtures = [
  // 私聊
  { name: 'private 默认必回（概率 1 也不挡）', reason: 'private', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'private 无配置必回', reason: 'private', cfg: cfgs.missing, roll: 0.99, expect: 'accept' },
  { name: 'private privateAlwaysReply=false 且命中 → 忽略', reason: 'private', cfg: cfgs.privateOn, roll: 0.4, expect: 'ignore' },
  { name: 'private privateAlwaysReply=false 未命中 → 受理', reason: 'private', cfg: cfgs.privateOn, roll: 0.6, expect: 'accept' },
  { name: 'private privateAlwaysReply=true → 受理', reason: 'private', cfg: cfgs.privateOff, roll: 0.1, expect: 'accept' },

  // 明确请求：不抽随机
  { name: '@ 命中随机值也受理', reason: 'atMention', cfg: cfgs.prod, roll: 0.1, expect: 'accept' },
  { name: '@ 概率 1 仍受理', reason: 'atMention', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'question 受理', reason: 'question', cfg: cfgs.prod, roll: 0.01, expect: 'accept' },
  { name: 'poke 受理', reason: 'poke', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'continuation 受理（引用追问）', reason: 'continuation', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'nightBacklog 受理', reason: 'nightBacklog', cfg: cfgs.full, roll: 0, expect: 'accept' },

  // 定时类：不抽随机
  { name: 'replyCheck 受理', reason: 'replyCheck', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'timeout 受理', reason: 'timeout', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'proactiveCheck 受理', reason: 'proactiveCheck', cfg: cfgs.full, roll: 0, expect: 'accept' },
  { name: 'bootstrap 受理', reason: 'bootstrap', cfg: cfgs.full, roll: 0, expect: 'accept' },

  // 软触发：抽随机
  { name: 'nameMention 命中 → 忽略', reason: 'nameMention', cfg: cfgs.prod, roll: 0.34, expect: 'ignore' },
  { name: 'nameMention 边界 0.35 → 受理', reason: 'nameMention', cfg: cfgs.prod, roll: 0.35, expect: 'accept' },
  { name: 'keyword 命中 → 忽略', reason: 'keyword', cfg: cfgs.prod, roll: 0.1, expect: 'ignore' },
  { name: 'topicKeywords 命中 → 忽略', reason: 'topicKeywords', cfg: cfgs.prod, roll: 0.1, expect: 'ignore' },
  { name: 'probability 命中 → 忽略', reason: 'probability', cfg: cfgs.prod, roll: 0.1, expect: 'ignore' },
  { name: '软触发无配置 → 受理', reason: 'keyword', cfg: cfgs.missing, roll: 0, expect: 'accept' },
  { name: '非法概率视为 0 → 受理', reason: 'keyword', cfg: cfgs.bad, roll: 0, expect: 'accept' },
  { name: 'NaN 随机源 → 受理', reason: 'keyword', cfg: cfgs.prod, roll: NaN, expect: 'accept' },
  { name: '未知原因按软触发处理', reason: 'someFutureReason', cfg: cfgs.prod, roll: 0.1, expect: 'ignore' },
  { name: '重复执行一致', reason: 'nameMention', cfg: cfgs.prod, roll: 0.1, expect: 'ignore', repeat: true },
  { name: '关闭全部概率 → 受理', reason: 'nameMention', cfg: cfgs.off, roll: 0, expect: 'accept' },
];

let pass = 0;
const failures = [];
for (const f of fixtures) {
  const run = () => decideWakeGate({ reason: f.reason, cfg: f.cfg, random: () => f.roll });
  const got = run();
  try {
    assert.equal(got.action, f.expect, `${f.name}: 期望 ${f.expect}，实际 ${got.action}`);
    assert.equal(got.reasonCode === REASON_CODES.ACCEPTED, f.expect === 'accept', `${f.name}: reasonCode 与 action 不一致`);
    assert.equal(got.policyVersion, 'wake-policy/2');
    if (f.repeat) assert.deepEqual(run(), got, `${f.name}: 重复执行结果不一致`);
    pass += 1;
  } catch (e) {
    failures.push(e.message);
  }
}

// 概率取值函数
const probChecks = [
  ['private 默认 → 0', ignoreProbabilityFor('private', cfgs.prod) === 0],
  ['private 关闭必回 → 0.5', ignoreProbabilityFor('private', cfgs.privateOn) === 0.5],
  ['@ → 0（豁免）', ignoreProbabilityFor('atMention', cfgs.prod) === 0],
  ['question → 0（豁免）', ignoreProbabilityFor('question', cfgs.prod) === 0],
  ['nameMention → 0.35', ignoreProbabilityFor('nameMention', cfgs.prod) === 0.35],
  ['bad → 0', ignoreProbabilityFor('keyword', cfgs.bad) === 0],
];
for (const [name, ok] of probChecks) {
  if (ok) pass += 1;
  else failures.push(`概率取值错误：${name}`);
}

// trace：默认关闭不落盘；开启写合法 JSONL 且截断
const traceFile = path.join(os.tmpdir(), `trace-test-${process.pid}.jsonl`);
fs.rmSync(traceFile, { force: true });
process.env.QQ_TRACE = '0';
const traceOff = await import('../../qq-bridge/src/trace.js');
traceOff.emitEvent({ decision: 'accept' });
if (fs.existsSync(traceFile)) failures.push('trace 默认不应写文件');
else pass += 1;

process.env.QQ_TRACE = '1';
process.env.QQ_TRACE_FILE = traceFile;
const traceOn = await import(`../../qq-bridge/src/trace.js?on=${Date.now()}`);
traceOn.emitEvent({ conversationKey: 'group:1', decision: 'ignore', reasonCode: 'IGNORED_SOFT_PROBABILITY', note: 'x'.repeat(400) });
try {
  const evt = JSON.parse(fs.readFileSync(traceFile, 'utf8').trim().split('\n')[0]);
  assert.equal(evt.decision, 'ignore');
  assert.ok(evt.note.length <= 301, 'note 应被截断');
  pass += 1;
} catch (e) {
  failures.push(`trace 写入校验失败：${e.message}`);
}

console.log(`wake-policy v2 fixtures: ${pass} 项通过，${failures.length} 项失败（场景 ${fixtures.length}）`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('全部通过');
