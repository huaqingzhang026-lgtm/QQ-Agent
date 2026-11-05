// 脚本 → 桥接的统一外发助手（F02/F03 的可测入口）。
//
// 为什么单独成模块：三个定时脚本原来各自写一份 fetch，出错后行为不一致
// （有的回退直连、有的只记日志）。抽出来后：
//   · 只有一条路径：POST /api/outbound/notify；
//   · 失败即失败（ok:false / 网络错误），调用方不得回退直连；
//   · 便于用假桥接注入 403/429/502/超时 等分支做测试。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function bridgeBaseUrl() {
  return String(process.env.HER_BRIDGE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
}

export function consoleTokenFile() {
  return process.env.HER_CONSOLE_TOKEN_FILE || path.join(ROOT, 'qq-bridge', 'state', 'console-token');
}

function readToken() {
  try { return fs.readFileSync(consoleTokenFile(), 'utf8').trim(); } catch { return ''; }
}

/**
 * @returns {Promise<{ok: boolean, status?: number, error?: string, messageId?: string|null}>}
 */
export async function notifyViaBridge({ key, text, exempt = false, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const token = readToken();
  try {
    const res = await fetchImpl(`${bridgeBaseUrl()}/api/outbound/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
      body: JSON.stringify({ key, text, exempt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = {};
    try { body = await res.json(); } catch { body = {}; }
    if (!res.ok || body.ok !== true) {
      return { ok: false, status: res.status, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, messageId: body.messageId ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
