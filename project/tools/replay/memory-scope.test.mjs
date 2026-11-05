// 回放：记忆检索会话令牌（F01）。
//
// 断言重点：
//   · 令牌只对签发时的 scopeKey 有效；
//   · 错误密钥、篡改、过期（超过一档）都返回 null；
//   · 可见 scope：自己的会话 + shared；配置的共享群才互看。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSecret, mintScopeToken, verifyScopeToken, allowedScopes, isRecordVisible, TOKEN_TTL_MS,
} from '../../qq-bridge/src/memory-scope.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const secret = 'a'.repeat(64);
const now = 1_000_000_000_000;

check('签发/校验往返', () => {
  const t = mintScopeToken(secret, 'group:20001', now);
  assert.equal(verifyScopeToken(secret, t, now), 'group:20001');
});

check('私聊 key 也能签发', () => {
  const t = mintScopeToken(secret, 'private:10001', now);
  assert.equal(verifyScopeToken(secret, t, now), 'private:10001');
});

check('错误密钥 → null', () => {
  const t = mintScopeToken(secret, 'group:1', now);
  assert.equal(verifyScopeToken('b'.repeat(64), t, now), null);
});

check('篡改 scopeKey → null', () => {
  const t = mintScopeToken(secret, 'group:1', now);
  const parts = t.split('.');
  const forged = `${Buffer.from('group:2').toString('base64url')}.${parts[1]}.${parts[2]}`;
  assert.equal(verifyScopeToken(secret, forged, now), null);
});

check('过期（超过一档）→ null', () => {
  const t = mintScopeToken(secret, 'group:1', now);
  assert.equal(verifyScopeToken(secret, t, now + 3 * TOKEN_TTL_MS), null);
});

check('上一档仍可用（跨窗口边界）', () => {
  const t = mintScopeToken(secret, 'group:1', now);
  assert.equal(verifyScopeToken(secret, t, now + TOKEN_TTL_MS), 'group:1');
});

check('空令牌 → null', () => {
  assert.equal(verifyScopeToken(secret, '', now), null);
  assert.equal(verifyScopeToken(secret, 'garbage', now), null);
});

check('可见 scope：群只见自己+shared', () => {
  const a = allowedScopes({ scopeKey: 'group:A' });
  assert.ok(a.has('group:A'));
  assert.ok(a.has('shared'));
  assert.ok(!a.has('group:B'));
  assert.ok(!a.has('private:1'));
});

check('可见 scope：共享群互看', () => {
  const a = allowedScopes({ scopeKey: 'group:A', shareGroups: ['group:A', 'group:B'] });
  assert.ok(a.has('group:B'));
});

check('可见 scope：私聊不见群', () => {
  const a = allowedScopes({ scopeKey: 'private:1' });
  assert.ok(!a.has('group:A'));
});

check('记录可见性', () => {
  const allowed = allowedScopes({ scopeKey: 'group:A' });
  assert.equal(isRecordVisible('shared', allowed), true);
  assert.equal(isRecordVisible('group:A', allowed), true);
  assert.equal(isRecordVisible('group:B', allowed), false);
  assert.equal(isRecordVisible('private:1', allowed), false);
});

check('无令牌只能看 shared', () => {
  const allowed = allowedScopes({ scopeKey: '' });
  assert.equal(isRecordVisible('group:A', allowed), false);
  assert.equal(isRecordVisible('private:1', allowed), false);
  assert.equal(isRecordVisible('shared', allowed), true);
});

check('ensureSecret 生成并复用', () => {
  const file = path.join(os.tmpdir(), `mem-secret-${process.pid}.key`);
  fs.rmSync(file, { force: true });
  const s1 = ensureSecret(file);
  const s2 = ensureSecret(file);
  assert.equal(s1, s2);
  assert.ok(/^[0-9a-f]{64}$/i.test(s1));
  fs.rmSync(file, { force: true });
});

console.log(`memory-scope replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
