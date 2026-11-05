// 回放：配置校验（config-schema）。

import assert from 'node:assert/strict';
import { validateConfig } from '../../qq-bridge/src/config-schema.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const base = () => ({
  model: 'deepseek-flash',
  snowluma: { httpUrl: 'http://127.0.0.1:3000' },
  allow: { private: ['10001', '*'], groups: ['20001'] },
  socialV2: {
    send: { maxSendPerMinute: 10, maxSendPerHour: 300 },
    wake: { ignoreProbability: 0.35, ignoreAtMentionProbability: 0.2, pokeReplyProbability: 0.05 },
    proactive: { probability: 0.1, maxPerHour: 2 },
    silentConversations: [],
  },
});

check('合法配置通过', () => {
  const r = validateConfig(base());
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

check('非对象被拒', () => {
  for (const v of [null, 42, 'x', []]) {
    const r = validateConfig(v);
    assert.equal(r.ok, false);
  }
});

check('maxSendPerMinute 越界被夹住', () => {
  const c = base(); c.socialV2.send.maxSendPerMinute = 999;
  const r = validateConfig(c);
  assert.equal(r.sanitized.socialV2.send.maxSendPerMinute, 30);
  assert.ok(r.warnings.some((w) => w.includes('maxSendPerMinute')));
});

check('概率 > 1 被夹到 1', () => {
  const c = base(); c.socialV2.wake.ignoreProbability = 3;
  const r = validateConfig(c);
  assert.equal(r.sanitized.socialV2.wake.ignoreProbability, 1);
});

check('负概率夹到 0', () => {
  const c = base(); c.socialV2.proactive.probability = -0.5;
  const r = validateConfig(c);
  assert.equal(r.sanitized.socialV2.proactive.probability, 0);
});

check('非数字概率 → 报错并丢弃该字段', () => {
  const c = base(); c.socialV2.wake.ignoreProbability = 'abc';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('不是数字')));
});

check('负衰减 → 报错', () => {
  const c = base(); c.socialV2.harassment = { decayPerMin: -0.5 };
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('decayPerMin')));
});

check('夜间小时越界 → 报错', () => {
  const c = base(); c.socialV2.queue = { nightStartHour: 30 };
  const r = validateConfig(c);
  assert.equal(r.ok, false);
});

check('overrides 概率越界 → 报错', () => {
  const c = base(); c.socialV2.proactive.conversationOverrides = { 'group:1': { probability: 2 } };
  const r = validateConfig(c);
  assert.equal(r.ok, false);
});

check('allow 非数组报错', () => {
  const c = base(); c.allow.groups = '20001';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('allow.groups')));
});

check('allow 非法项报错', () => {
  const c = base(); c.allow.private = [{ x: 1 }];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
});

check('model 空字符串报错', () => {
  const c = base(); c.model = '  ';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
});

check('snowluma.httpUrl 协议非法报错', () => {
  const c = base(); c.snowluma.httpUrl = 'ws://127.0.0.1:3001';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
});

check('silentConversations 非法键报错', () => {
  const c = base(); c.socialV2.silentConversations = ['猫窝'];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
});

check('silentConversations 合法键通过', () => {
  const c = base(); c.socialV2.silentConversations = ['group:20002', 'private:1'];
  assert.equal(validateConfig(c).ok, true);
});

check('harassment 阈值越界夹住', () => {
  const c = base(); c.socialV2.harassment = { muteThreshold: 99, muteMinutes: 0 };
  const r = validateConfig(c);
  assert.equal(r.sanitized.socialV2.harassment.muteThreshold, 10);
  assert.equal(r.sanitized.socialV2.harassment.muteMinutes, 1);
});

check('queue TTL 过小夹住', () => {
  const c = base(); c.socialV2.queue = { softTtlMs: 5, explicitTtlMs: 99999999 };
  const r = validateConfig(c);
  assert.equal(r.sanitized.socialV2.queue.softTtlMs, 1000);
  assert.equal(r.sanitized.socialV2.queue.explicitTtlMs, 3600000);
});

check('缺失字段不报错、不臆造', () => {
  const r = validateConfig({ model: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.socialV2, undefined);
});

check('不修改入参（深拷贝）', () => {
  const c = base(); c.socialV2.send.maxSendPerMinute = 999;
  validateConfig(c);
  assert.equal(c.socialV2.send.maxSendPerMinute, 999);
});

console.log(`config-schema replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
