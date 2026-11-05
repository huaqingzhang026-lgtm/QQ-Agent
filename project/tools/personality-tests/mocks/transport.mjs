// 传输 mock：只做捕获，不发起任何网络/OneBot 调用。
//
// 设计约束（A00 隔离要求）：
//   · 本文件**不得** import qq-bridge/src/transport.js、node:http、node:net、node:dns 等；
//   · postOneBot 只把请求记录到内存，返回确定的 "已捕获" 结果；
//   · 调用方即使传入真实 fetchImpl，也不会被调用——mock 根本不持有网络实现。
import crypto from 'node:crypto';

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

export function createMockTransport({ name = 'mock-transport' } = {}) {
  const calls = [];
  let seq = 0;
  return {
    name,
    calls,
    get capturedCount() { return calls.length; },
    postOneBot(request) {
      seq += 1;
      const captured = clone(request);
      const record = {
        seq,
        at: new Date().toISOString(),
        action: captured?.action ?? null,
        conversationKey: captured?.conversationKey ?? null,
        request: captured,
        contentHash: crypto.createHash('sha256').update(JSON.stringify(captured)).digest('hex').slice(0, 16),
      };
      calls.push(record);
      return { ok: true, dryRun: true, captured: true, messageId: `mock-${seq}`, capturedAt: record.at };
    },
    drain() { const out = calls.slice(); calls.length = 0; return out; },
    reset() { calls.length = 0; seq = 0; },
  };
}

// 真实 fetch 的哨兵：如果有人试图发网络请求，会抛错并计数，便于自检断言"从未触达"。
export function createFetchSentinel() {
  const attempts = [];
  const fetchImpl = (url, init) => {
    attempts.push({ url: String(url), at: new Date().toISOString(), init: clone(init) });
    throw new Error(`emit: forbidden real fetch attempted -> ${String(url).slice(0, 120)}`);
  };
  return { fetchImpl, attempts, get count() { return attempts.length; } };
}
