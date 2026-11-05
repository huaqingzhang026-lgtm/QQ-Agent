// 端到端回放：外发传输层（transport）的 20 个场景。
//
// 核心断言（改造方案 §4.3 / §6.5）：
//   · dry-run 下所有外部 HTTP 调用次数必须为 0；
//   · live 下每次发送恰好调用一次 fetch，头/体/超时与直连等价；
//   · 失败分类（retcode、HTTP、坏 JSON、超时）不被吞掉。
//
// 运行：node tools/replay/transport-replay.test.mjs

import assert from 'node:assert/strict';

let pass = 0;
const failures = [];
const ok = (name, fn) => {
  try { fn(); pass += 1; } catch (e) { failures.push(`${name}: ${e.message}`); }
};
const okAsync = async (name, fn) => {
  try { await fn(); pass += 1; } catch (e) { failures.push(`${name}: ${e.message}`); }
};

// 每次import都拿新模块实例，避免 DRY_RUN 在导入时固化
let seq = 0;
async function freshTransport(dryRun) {
  process.env.QQ_DRY_RUN = dryRun ? '1' : '0';
  const mod = await import(`../../qq-bridge/src/transport.js?case=${++seq}`);
  mod.resetTransportStats();
  return mod;
}

const base = { httpUrl: 'http://127.0.0.1:3000', accessToken: 't0ken', action: 'send_group_msg', params: { group_id: 123, message: [{ type: 'text', data: { text: 'hi' } }] } };

function fakeFetch(behavior) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (behavior === 'throw') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (behavior === 'http500') return { ok: false, status: 500, json: async () => ({ status: 'failed', retcode: 500 }) };
    if (behavior === '429') return { ok: false, status: 429, json: async () => ({ status: 'failed', retcode: 1200 }) };
    if (behavior === 'badjson') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
    if (behavior === 'retcode') return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 100 }) };
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 42 } }) };
  };
  fn.calls = calls;
  return fn;
}

// ── dry-run：外部调用必须为 0 ───────────────────────────────────────────────
for (const [i, scenario] of [
  ['群文本', base],
  ['私聊文本', { ...base, action: 'send_private_msg', params: { user_id: 9, message: [{ type: 'text', data: { text: 'hi' } }] } }],
  ['表情', { ...base, params: { group_id: 123, message: [{ type: 'image', data: { file: 'abc.gif' } }] } }],
  ['语音', { ...base, params: { group_id: 123, message: [{ type: 'record', data: { file: 'v.amr' } }] } }],
  ['多段（@+文本）', { ...base, params: { group_id: 123, message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: 'hi' } }] } }],
].entries()) {
  await okAsync(`dry-run · ${scenario[0]}`, async () => {
    const T = await freshTransport(true);
    const f = fakeFetch('ok');
    const r = await T.postOneBot({ ...scenario[1], fetchImpl: f });
    assert.equal(f.calls.length, 0, 'dry-run 不得调用 fetch');
    assert.equal(r.dryRun, true);
    assert.equal(T.transportStats().blocked, 1);
  });
}

await okAsync('dry-run · 连续 20 次发送，外部调用仍为 0', async () => {
  const T = await freshTransport(true);
  const f = fakeFetch('ok');
  for (let i = 0; i < 20; i++) await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.equal(T.transportStats().blocked, 20);
});

await okAsync('dry-run · fetch 会抛错也不会被调用', async () => {
  const T = await freshTransport(true);
  const f = fakeFetch('throw');
  const r = await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.equal(r.ok, true);
});

// ── live：与直连等价 ────────────────────────────────────────────────────────
await okAsync('live · 成功发送', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  const r = await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body.data, { message_id: 42 });
  assert.equal(T.transportStats().sent, 1);
});

await okAsync('live · URL 拼接正确', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, httpUrl: 'http://127.0.0.1:3000/', fetchImpl: f });
  assert.equal(f.calls[0].url, 'http://127.0.0.1:3000/send_group_msg');
});

await okAsync('live · 携带 Bearer 令牌', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls[0].opts.headers.authorization, 'Bearer t0ken');
});

await okAsync('live · 无令牌时不带 authorization', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, accessToken: '', fetchImpl: f });
  assert.equal(f.calls[0].opts.headers.authorization, undefined);
});

await okAsync('live · body 为 params 的 JSON', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, fetchImpl: f });
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), base.params);
});

await okAsync('live · POST + content-type + 超时信号', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.headers['content-type'], 'application/json');
  assert.ok(f.calls[0].opts.signal, '应带 AbortSignal');
});

await okAsync('live · retcode 非 0 判失败', async () => {
  const T = await freshTransport(false);
  const r = await T.postOneBot({ ...base, fetchImpl: fakeFetch('retcode') });
  assert.equal(r.ok, false);
  assert.equal(T.transportStats().failed, 1);
});

await okAsync('live · HTTP 500 判失败', async () => {
  const T = await freshTransport(false);
  const r = await T.postOneBot({ ...base, fetchImpl: fakeFetch('http500') });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
});

await okAsync('live · HTTP 429 判失败且状态保留', async () => {
  const T = await freshTransport(false);
  const r = await T.postOneBot({ ...base, fetchImpl: fakeFetch('429') });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.body.retcode, 1200);
});

await okAsync('live · 坏 JSON 不抛错，按失败处理', async () => {
  const T = await freshTransport(false);
  const r = await T.postOneBot({ ...base, fetchImpl: fakeFetch('badjson') });
  assert.equal(r.ok, false);
  assert.deepEqual(r.body, {});
});

await okAsync('live · 超时异常向上抛', async () => {
  const T = await freshTransport(false);
  await assert.rejects(() => T.postOneBot({ ...base, fetchImpl: fakeFetch('throw') }), /aborted/);
});

await okAsync('live · 每次发送恰好一次 fetch', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  for (let i = 0; i < 5; i++) await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls.length, 5);
  assert.equal(T.transportStats().sent, 5);
});

await okAsync('live · 统计可重置', async () => {
  const T = await freshTransport(false);
  await T.postOneBot({ ...base, fetchImpl: fakeFetch('ok') });
  T.resetTransportStats();
  assert.deepEqual(T.transportStats().sent, 0);
});

await okAsync('live · 群/私聊的目标键不同', async () => {
  const T = await freshTransport(false);
  const f = fakeFetch('ok');
  const sent = [];
  const orig = T.postOneBot;
  const r1 = await orig({ ...base, fetchImpl: f });
  const r2 = await orig({ ...base, action: 'send_private_msg', params: { user_id: 9, message: [] }, fetchImpl: f });
  sent.push(r1.ok, r2.ok);
  assert.deepEqual(sent, [true, true]);
  assert.equal(f.calls.length, 2);
});

// ── 运行期 dry-run 开关（config.socialV2.outbound.dryRun）────────────────────
await okAsync('运行期 setDryRun(true) 阻断外发', async () => {
  process.env.QQ_DRY_RUN = '0';
  const T = await import(`../../qq-bridge/src/transport.js?rt=${Date.now()}`);
  T.setDryRun(true);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls.length, 0);
  T.setDryRun(false);
});

await okAsync('运行期 setDryRun(false) 恢复外发', async () => {
  const T = await import(`../../qq-bridge/src/transport.js?rt2=${Date.now()}`);
  T.setDryRun(false);
  const f = fakeFetch('ok');
  await T.postOneBot({ ...base, fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

// ── 结果 ────────────────────────────────────────────────────────────────────
console.log(`transport replay: ${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('全部通过（dry-run 外发 0 次、live 语义一致）');
