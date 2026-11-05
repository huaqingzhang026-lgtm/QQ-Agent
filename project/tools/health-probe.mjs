// 端到端健康探针：端口 + 桥接状态 + DSH + SnowLuma + 队列 + 模型网关。
// 由 live-watch 每 5 分钟拉起；异常私聊主人，30 分钟内不重复。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { notifyViaBridge } from './lib/bridge-notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const LOG = path.join(STATE, 'health-probe.log');
const STATE_FILE = path.join(STATE, 'health-probe.json');
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };

function tcp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(3000);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function bridgeStatus() {
  const token = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();
  try {
    const r = await fetch('http://127.0.0.1:3100/api/status', { headers: token ? { 'x-console-token': token } : {}, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && !!j, body: j, error: r.ok ? '' : 'HTTP ' + r.status };
  } catch (e) { return { ok: false, body: null, error: e?.message ?? e }; }
}

function queueDepth() {
  try {
    const s = readJson(path.join(STATE, 'social-v2.json'), { conversations: {} });
    let n = 0;
    for (const c of Object.values(s.conversations || {})) n += Array.isArray(c?.pendingWakeReasons) ? c.pendingWakeReasons.length : 0;
    return n;
  } catch { return 0; }
}

const AUTO = process.argv.includes('--auto');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function runTask(name) {
  return new Promise((resolve) => execFile('schtasks', ['/Run', '/TN', name], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || err?.message || '') })));
}
function canRestart(old, name, now) {
  const s = old.restarts?.[name] || { at: [], count: 0 };
  s.at = (s.at || []).filter((x) => now - x < 60 * 60 * 1000);
  if (s.at.length >= 3) return { ok: false, reason: '3/小时上限' };
  if (s.at.length && now - s.at[s.at.length - 1] < 10 * 60 * 1000) return { ok: false, reason: '10分钟冷却' };
  return { ok: true, state: s };
}
async function autoHeal(checks, old, now) {
  const tasks = [];
  if (!checks.ports[3080] || !checks.bridge.dshReady) tasks.push('HerDSH');
  if (!checks.ports[3100]) tasks.push('HerBridge');
  if (!checks.ports[3000] && !checks.ports[3001]) tasks.push('HerSnowLuma');
  if (!checks.ports[18060]) tasks.push('HerXHS');
  const done = [];
  for (const name of [...new Set(tasks)]) {
    const gate = canRestart(old, name, now);
    if (!gate.ok) { done.push({ name, skipped: gate.reason }); continue; }
    const r = await runTask(name);
    gate.state.at = [...(gate.state.at || []), now];
    old.restarts = old.restarts || {};
    old.restarts[name] = gate.state;
    done.push({ name, ok: r.ok, out: r.out.slice(0, 120) });
    log('自动重启 ' + name + '：' + (r.ok ? '已触发' : '失败'));
    await sleep(name === 'HerDSH' ? 30000 : 15000);
  }
  return done;
}
async function modelProbe(old = {}) {
  const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
  const a = cfg?.socialV2?.qzone?.astra;
  if (!a?.apiKey) return { ok: true, skipped: true };
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(String(a.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '') + '/models', { headers: { authorization: 'Bearer ' + a.apiKey }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) return { ok: false, status: r.status };
      const now = Date.now();
      if (now - Number(old.lastInferenceAt || 0) > 15 * 60 * 1000) {
        const ir = await fetch(String(a.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.apiKey },
          body: JSON.stringify({ model: a.model || 'gpt-6-astra', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, reasoning_effort: 'low' }),
          signal: AbortSignal.timeout(30000),
        });
        if (!ir.ok) return { ok: false, status: ir.status, inference: true };
        old.lastInferenceAt = now;
      }
      return { ok: true, status: r.status, inference: 'checked' };
    } catch (e) { if (i === 0) await new Promise((r) => setTimeout(r, 2000)); else return { ok: false, error: e?.message ?? e }; }
  }
  return { ok: false, error: 'probe failed' };
}

const old = readJson(STATE_FILE, {});
const checks = {};
checks.ports = {};
for (const p of [3080, 3100, 3000, 3001, 18060]) checks.ports[p] = await tcp(p);
const st = await bridgeStatus();
checks.bridge = { ok: st.ok && st.body?.dshReady === true, error: st.error, dshReady: st.body?.dshReady };
const sl = st.body?.snowluma || {};
checks.snowluma = { ok: sl.good !== false && sl.connected !== false && Number(sl.lastPacketAgoMs ?? 0) < 3 * 60 * 1000, good: sl.good, connected: sl.connected, lastPacketAgoMs: sl.lastPacketAgoMs };
checks.queue = { ok: queueDepth() <= 20, depth: queueDepth() };
checks.model = await modelProbe(old);
const modelStreak = checks.model.ok ? 0 : (Number(old.modelFailStreak || 0) + 1);
checks.model.streak = modelStreak;
if (!checks.model.ok && modelStreak < 3) { checks.model.ok = true; checks.model.transient = true; }
checks.ok = Object.values(checks.ports).every(Boolean) && checks.bridge.ok && checks.snowluma.ok && checks.queue.ok && checks.model.ok;

const now = Date.now();
if (!checks.ok && AUTO) {
  const healed = await autoHeal(checks, old, now);
  if (healed.length) {
    for (const p of [3080, 3100, 3000, 3001, 18060]) checks.ports[p] = await tcp(p);
    const st2 = await bridgeStatus();
    checks.bridge = { ok: st2.ok && st2.body?.dshReady === true, error: st2.error, dshReady: st2.body?.dshReady };
    const sl2 = st2.body?.snowluma || {};
    checks.snowluma = { ok: sl2.good !== false && sl2.connected !== false && Number(sl2.lastPacketAgoMs ?? 0) < 3 * 60 * 1000, good: sl2.good, connected: sl2.connected, lastPacketAgoMs: sl2.lastPacketAgoMs };
    checks.queue = { ok: queueDepth() <= 20, depth: queueDepth() };
    checks.model = await modelProbe(old);
    checks.ok = Object.values(checks.ports).every(Boolean) && checks.bridge.ok && checks.snowluma.ok && checks.queue.ok && checks.model.ok;
    checks.healed = healed;
    if (!checks.ok && healed.some((x) => x.skipped || x.ok === false) && now - Number(old.escalatedAt || 0) > 30 * 60 * 1000) {
      const r = await notifyViaBridge({ key: 'private:' + String(readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {}).ownerQQ || ''), text: '🚨 Pluto 自动恢复失败，需要人工检查：' + reasonText(checks), exempt: true });
      log('已升级告警：' + JSON.stringify(r));
      old.escalatedAt = now;
    }
  }
}
function reasonText(checks) {
  return [!Object.values(checks.ports).every(Boolean) ? '端口异常' : '', !checks.bridge.ok ? '桥接/DSH 未就绪' : '', !checks.snowluma.ok ? 'SnowLuma 异常' : '', !checks.queue.ok ? '队列积压' : '', !checks.model.ok ? '模型网关异常' : ''].filter(Boolean).join('；');
}
const hardFail = !Object.values(checks.ports).every(Boolean) || !checks.bridge.ok || !checks.snowluma.ok || !checks.queue.ok;
const failStreak = checks.ok ? 0 : (hardFail ? Number(old.failStreak || 0) + 1 : Number(old.failStreak || 0));
const alertThreshold = hardFail ? 2 : 3;
const persistentFail = checks.ok ? false : (hardFail ? failStreak >= alertThreshold : modelStreak >= 3);
if (!checks.ok) {
  const reason = [
    !Object.values(checks.ports).every(Boolean) ? '端口异常' : '',
    !checks.bridge.ok ? '桥接/DSH 未就绪' : '',
    !checks.snowluma.ok ? 'SnowLuma 收包异常' : '',
    !checks.queue.ok ? '唤醒队列积压 ' + checks.queue.depth : '',
    !checks.model.ok ? '模型网关不可用' : '',
  ].filter(Boolean).join('；');
  log('异常：' + reason + ' 连续=' + failStreak + ' 模型连续=' + modelStreak + ' ' + JSON.stringify(checks));
  if (!persistentFail) log('未达告警阈值（硬故障 ' + alertThreshold + ' 次 / 模型 3 次），暂不打扰主人');
  else if (now - Number(old.lastAlertAt || 0) > 30 * 60 * 1000) {
    const r = await notifyViaBridge({ key: 'private:' + String(readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {}).ownerQQ || ''), text: '⚠️ Pluto 健康探针异常：' + reason, exempt: true });
    log('已通知主人：' + JSON.stringify(r));
    old.lastAlertAt = now; old.alertSent = true;
  }
} else {
  if (old.alertSent) { log('恢复正常'); const r = await notifyViaBridge({ key: 'private:' + String(readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {}).ownerQQ || ''), text: '✅ Pluto 健康探针已恢复正常', exempt: true }); log('已通知主人恢复：' + JSON.stringify(r)); old.lastAlertAt = 0; old.alertSent = false; }
  checks.reason = '';
}
old.at = now; old.ok = checks.ok; old.checks = checks; old.lastAlertAt = Number(old.lastAlertAt) || 0; old.modelFailStreak = modelStreak; old.failStreak = failStreak;
writeJson(STATE_FILE, old);
log('结果：' + (checks.ok ? 'OK' : 'FAIL'));
