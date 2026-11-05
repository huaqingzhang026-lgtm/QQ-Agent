// 记忆检索的会话身份令牌（F01）：把"我是哪个会话"变成不可伪造的 HMAC 令牌。
//
// 问题：memory-mcp 是全局 MCP，工具参数里的 key 由模型填写，等于可伪造；
// 只要 memory_search 遍历全部会话，群聊就能读私聊。
//
// 方案：桥接用本机密钥为当前会话签一个短期令牌，注入唤醒 prompt；模型调用
// memory_search 时必须带上它。memory-mcp 校验后只返回该会话可见的 scope：
//   · shared（她自己的笔记/知识库/亲密度/表情备注）
//   · 该会话自己的记录
//   · 群之间按 MEMORY_SHARE_GROUPS 显式配置的共享集合（默认两类示例主播群互看）

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const TOKEN_TTL_MS = 15 * 60 * 1000;

export function ensureSecret(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(s)) return s;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${secret}\n`, 'utf8');
  } catch {}
  return secret;
}

function sig(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** 生成令牌：<base64url(scopeKey)>.<bucket>.<hmac> */
export function mintScopeToken(secret, scopeKey, now = Date.now(), ttlMs = TOKEN_TTL_MS) {
  const bucket = Math.floor(now / ttlMs);
  const key = String(scopeKey ?? '');
  if (!key) return '';
  const enc = Buffer.from(key, 'utf8').toString('base64url');
  return `${enc}.${bucket}.${sig(secret, `${enc}|${bucket}`)}`;
}

/** 校验令牌；返回 scopeKey 或 null。允许上一档（跨窗口边界）。 */
export function verifyScopeToken(secret, token, now = Date.now(), ttlMs = TOKEN_TTL_MS) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [enc, bucketStr, mac] = parts;
  const bucket = Number(bucketStr);
  if (!Number.isSafeInteger(bucket)) return null;
  const current = Math.floor(now / ttlMs);
  if (bucket !== current && bucket !== current - 1) return null;
  let expected;
  try { expected = sig(secret, `${enc}|${bucket}`); } catch { return null; }
  const a = Buffer.from(String(mac), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return Buffer.from(enc, 'base64url').toString('utf8'); } catch { return null; }
}

/**
 * 该会话可见的 scope 集合。
 * @param {{scopeKey: string, shareGroups?: string[]}} input
 */
export function allowedScopes({ scopeKey, shareGroups = [] } = {}) {
  const set = new Set(['shared']);
  const key = String(scopeKey ?? '');
  if (!key) return set;
  set.add(key);
  const share = new Set((shareGroups ?? []).map(String));
  if (share.has(key)) {
    for (const g of share) set.add(g);
  }
  return set;
}

export function isRecordVisible(recordScope, allowed) {
  const scope = String(recordScope ?? 'shared');
  if (scope === 'shared') return true;
  return allowed.has(scope);
}
