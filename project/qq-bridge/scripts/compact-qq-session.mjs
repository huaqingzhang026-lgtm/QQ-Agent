// QQ 会话的上下文看门狗。
//
// 背景（实测）：桥接那条常驻会话聊到 ~15 万 token 时，模型开始返回空内容，
// DSH 把它当 EMPTY_RESPONSE 重试 5 次后报 `DeepSeek Messages transport failed`，
// 于是她就"不回消息"了。真实模型上限低于 DSH 报的 contextWindow（1M），
// 所以不能等 DSH 自己压缩。
//
// 做法：定时查桥接当前在用的会话，pressureTokens 超过阈值就发 `/compact`；
// 压缩连续失败（或压力已逼近硬上限）就轮换：归档旧会话、清掉桥接的会话映射、
// 重启桥接——下一条消息会自动建一条干净会话。
//
// 用法：node scripts/compact-qq-session.mjs [--dry]
//   QQ_COMPACT_TOKENS   触发压缩的 token 数（默认 90000）
//   QQ_ROTATE_TOKENS    压缩失败时直接轮换的 token 数（默认 120000）
//   QQ_COMPACT_FAILS    连续失败几次后轮换（默认 3）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(here, '..', 'state');
const LOG_FILE = path.join(STATE, 'compact.log');
const STATE_FILE = path.join(STATE, 'compact-state.json');
const SESSIONS_FILE = path.join(STATE, 'sessions.json');

const BASE = (process.env.DSH_BASE_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const COMPACT_AT = Number(process.env.QQ_COMPACT_TOKENS || 90000);
const ROTATE_AT = Number(process.env.QQ_ROTATE_TOKENS || 120000);
const MAX_FAILS = Number(process.env.QQ_COMPACT_FAILS || 3);
const DRY = process.argv.includes('--dry');

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function rpc(cookie, method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'maint-' + Math.random().toString(36).slice(2, 8), method, payload: { args } }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const body = await res.json().catch(() => ({}));
  return body.result ?? body;
}

async function pressureOf(cookie, sessionId) {
  const r = await rpc(cookie, 'session/projections', { request: { sessionId } });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.value?.values?.contextPressure;
  return { ok: true, pressure: Number(p?.pressureTokens ?? 0), projected: Number(p?.projectedTokens ?? 0) };
}

function stopBridge() {
  const end = spawnSync('schtasks', ['/End', '/TN', 'HerBridge'], { encoding: 'utf8', windowsHide: true });
  if (end.status !== 0) log(`  ⚠️ schtasks /End HerBridge 退出码 ${end.status}`);
  spawnSync('ping', ['-n', '4', '127.0.0.1'], { windowsHide: true });
}
function startBridge() {
  const run = spawnSync('schtasks', ['/Run', '/TN', 'HerBridge'], { encoding: 'utf8', windowsHide: true });
  log(`  桥接已启动（/Run 退出码 ${run.status}）`);
}
function restartBridge() { stopBridge(); startBridge(); }

async function rotate(cookie, sessionId, reason, { restart = true } = {}) {
  log(`  ⇒ 轮换会话 ${sessionId}（${reason}）`);
  if (DRY) { log('  --dry：跳过实际轮换'); return; }
  const archived = await rpc(cookie, 'workspace/archiveSession', { request: { sessionId } });
  log(`  归档：${archived.ok ? 'ok' : JSON.stringify(archived.error).slice(0, 120)}`);
  const doc = readJson(SESSIONS_FILE, { sessions: {}, sessionPolicies: {} });
  for (const [key, value] of Object.entries(doc.sessions ?? {})) {
    if (value === sessionId) delete doc.sessions[key];
  }
  for (const [key, value] of Object.entries(doc.sessionPolicies ?? {})) {
    if (typeof value === 'string' && value.includes(sessionId)) delete doc.sessionPolicies[key];
  }
  saveJson(SESSIONS_FILE, doc);
  log(`  已清除桥接映射：${JSON.stringify(doc.sessions)}`);
  if (restart) restartBridge();
}

const cookie = discoverDshSessionCookie(BASE);
if (!cookie) { log('取不到 DSH 会话 Cookie（DSH 没起？DSH_HOME 不对？）'); process.exit(0); }

let probe;
// 2026-10-28 补（08:54 实测撞上）：DSH 正好在重启时，fetch 会直接抛 ECONNREFUSED，
// 未捕获 → 脚本静默崩，compact.log 一个字没写。
// 而"DSH 不稳"恰恰是最需要看门狗的时候，所以这里必须兜住。
try {
  probe = await rpc(cookie, 'session/list', { _request: {} });
} catch (e) {
  log(`连不上 DSH（${BASE}）：${String(e?.message ?? e).slice(0, 160)}`);
  process.exit(0);
}
// 2026-10-28 修（主人 08:03 回「可以」）：原来 probe.error 为 undefined 时
// JSON.stringify(undefined) 返回 undefined，再 .slice 就抛 TypeError，
// 而且 log() 在模板求值时已经崩了——所以 compact.log 从 10-22 起一个字没写，
// 每 30 分钟崩一次（累计 269 次），上下文压缩整整停了 5 天没人发现。
if (!probe?.ok) {
  const _detail = probe?.error === undefined ? '（响应里没有 error 字段）' : JSON.stringify(probe.error);
  log(`DSH 不可用：${String(_detail).slice(0, 160)}`);
  process.exit(0);
}

const mapping = readJson(SESSIONS_FILE, { sessions: {} });
const ids = [...new Set(Object.values(mapping.sessions ?? {}))];
if (ids.length === 0) { log('桥接当前没有绑定的会话（下一条消息会新建），无需处理'); process.exit(0); }

const state = readJson(STATE_FILE, {});
let changed = false;
for (const sessionId of ids) {
  const p = await pressureOf(cookie, sessionId);
  if (!p.ok) { log(`${sessionId} 读不到投影：${JSON.stringify(p.error).slice(0, 120)}`); continue; }
  log(`${sessionId} pressure=${p.pressure} (projected ${p.projected})`);
  if (p.pressure < COMPACT_AT) continue;

  const fails = Number(state[sessionId]?.fails ?? 0);
  log(`  超过阈值 ${COMPACT_AT} ⇒ /compact（此前连续失败 ${fails} 次）`);
  if (DRY) { log('  --dry：只报告，不执行'); continue; }

  const c = await rpc(cookie, 'commands/execute', { agentId: sessionId, line: '/compact', submittedAttachments: [] });
  const ok = c.ok && c.value?.result?.kind === 'success';
  if (ok) {
    log(`  压缩成功：${c.value?.result?.text ?? ''}`);
    delete state[sessionId]; changed = true;
    continue;
  }
  const text = c.ok ? c.value?.result?.text : JSON.stringify(c.error);
  log(`  压缩失败：${String(text).slice(0, 160)}`);
  // 她正在干活（回合未结束 / 已有压缩在跑）不算失败，下一轮再试，别把次数攒成轮换。
  if (/not idle|active compaction/i.test(String(text))) {
    if (p.pressure < ROTATE_AT) {
      log('  会话正忙，跳过本轮（不计失败，下轮再试）');
      continue;
    }
    // 压力已经逼近硬上限：把桥接停掉，她就不忙了，压缩完再拉起来。
    log(`  会话正忙但压力 ${p.pressure} ≥ ${ROTATE_AT}，暂停桥接后重试压缩`);
    stopBridge();
    const c2 = await rpc(cookie, 'commands/execute', { agentId: sessionId, line: '/compact', submittedAttachments: [] });
    if (c2.ok && c2.value?.result?.kind === 'success') {
      log(`  暂停状态下压缩成功：${c2.value?.result?.text ?? ''}`);
      delete state[sessionId]; changed = true;
      startBridge();
      continue;
    }
    log(`  暂停后仍失败：${String(c2.ok ? c2.value?.result?.text : JSON.stringify(c2.error)).slice(0, 160)}`);
    await rotate(cookie, sessionId, `暂停后压缩仍失败 / pressure ${p.pressure}`, { restart: false });
    delete state[sessionId];
    startBridge();
    continue;
  }
  state[sessionId] = { fails: fails + 1, lastError: String(text).slice(0, 200), at: new Date().toISOString() };
  changed = true;
  if (state[sessionId].fails >= MAX_FAILS || p.pressure >= ROTATE_AT) {
    await rotate(cookie, sessionId, `连续失败 ${state[sessionId].fails} 次 / pressure ${p.pressure}`);
    delete state[sessionId];
  }
}
if (changed && !DRY) saveJson(STATE_FILE, state);
log('检查结束');
