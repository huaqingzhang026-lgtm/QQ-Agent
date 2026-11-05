// 示例主播 开播提醒：轮询直播间状态，从"没播"变"直播中"就在群里喊一声。
// 只在状态切换时发（一次开播最多一条），避免刷屏。
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { notifyViaBridge as notifyBridge } from './lib/bridge-notify.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function ensureHealthProbe() {
  try {
    const logFile = path.join(STATE_DIR, 'health-probe.log');
    let last = 0;
    try { last = fs.statSync(logFile).mtimeMs; } catch {}
    if (Date.now() - last < 4 * 60 * 1000) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'health-probe.mjs'), '--auto'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}
function stopService(pidFile, label) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (pid && pidAlive(pid)) { try { process.kill(pid); log('已暂停' + label + ' pid=' + pid); } catch {} }
    try { fs.unlinkSync(pidFile); } catch {}
  } catch {}
}
function runTask(name) {
  try { childProcess.execFile('schtasks', ['/Run', '/TN', name], { timeout: 10000, windowsHide: true }, () => {}); } catch {}
}
function ensureSelfFixWatch() {
  try {
    const logFile = path.join(STATE_DIR, 'self-fix-watch.log');
    let last = 0;
    try { last = fs.statSync(logFile).mtimeMs; } catch {}
    if (Date.now() - last < 2 * 60 * 1000) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'self-fix-watch.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}
function ensureDailyLife() {
  try {
    const now = new Date();
    if (now.getHours() < 6) return;
    const date = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const file = path.join(ROOT, 'agent-home', 'life', 'daily', date + '.json');
    if (fs.existsSync(file)) return;
    const logFile = path.join(STATE_DIR, 'daily-life.log');
    let last = 0;
    try { last = fs.statSync(logFile).mtimeMs; } catch {}
    if (Date.now() - last < 3 * 60 * 1000) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'daily-life.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起今日生活生成');
  } catch {}
}
function ensureMemoryDigest() {
  try {
    const now = new Date();
    const d = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const stFile = path.join(ROOT, 'agent-home', 'memory', 'memory-digest-state.json');
    let st = {}; try { st = JSON.parse(fs.readFileSync(stFile, 'utf8')); } catch {}
    const { spawn } = childProcess;
    const run = (level, key, extra) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'memory-digest.mjs'), '--level=' + level, ...(extra || [])], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      st[key] = d;
      fs.mkdirSync(path.dirname(stFile), { recursive: true });
      fs.writeFileSync(stFile, JSON.stringify(st, null, 2) + '\n', 'utf8');
      log('已拉起记忆摘要：' + level);
    };
    const hh = now.getHours(), mm = now.getMinutes();
    if ((hh > 3 || (hh === 3 && mm >= 30)) && st.lastDaily !== d) run('daily', 'lastDaily');
    if (now.getDay() === 0 && hh >= 4 && st.lastWeekly !== d) run('weekly', 'lastWeekly');
    if (now.getDate() === 1 && hh >= 5 && st.lastMonthly !== d) run('monthly', 'lastMonthly');
    if (now.getDate() === 1 && hh >= 5 && st.lastArchive !== d) run('archive', 'lastArchive');
  } catch {}
}

function ensureGroupAddress() {
  try {
    const f = path.join(STATE_DIR, 'group-address.json');
    const last = (() => { try { return Date.parse(JSON.parse(fs.readFileSync(f, 'utf8')).updatedAt) || 0; } catch { return 0; } })();
    if (Date.now() - last < 2 * 60 * 60 * 1000) return;
    const lock = path.join(STATE_DIR, 'group-address.lock');
    const pid = (() => { try { return Number(fs.readFileSync(lock, 'utf8').trim()); } catch { return 0; } })();
    if (pid && pidAlive(pid)) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'group-address.mjs'), '--no-local'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    try { fs.writeFileSync(lock, String(child.pid), 'utf8'); } catch {}
    log('已拉起群称呼学习');
  } catch {}
}

function ensureKnowledgeJobs() {
  try {
    const now = new Date();
    const d = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const stFile = path.join(ROOT, 'agent-home', 'memory', 'knowledge-jobs-state.json');
    let st = {}; try { st = JSON.parse(fs.readFileSync(stFile, 'utf8')); } catch {}
    const { spawn } = childProcess;
    const run = (script, key) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'tools', script)], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref(); st[key] = d; fs.mkdirSync(path.dirname(stFile), { recursive: true }); fs.writeFileSync(stFile, JSON.stringify(st, null, 2) + '\n', 'utf8'); log('已拉起：' + script);
    };
    if (now.getHours() >= 4 && st.lastKnowledge !== d) run('bili-knowledge.mjs', 'lastKnowledge');
    if (now.getDay() === 0 && now.getHours() >= 4 && st.lastInterest !== d) run('bili-interest-discovery.mjs', 'lastInterest');
    if (now.getDay() === 0 && now.getHours() >= 4 && st.lastRelationship !== d) run('relationship-profile.mjs', 'lastRelationship');
    if (now.getDate() === 1 && now.getHours() >= 5 && st.lastSupersede !== d) run('memory-supersede.mjs', 'lastSupersede');
  } catch {}
}

function ensureBiliLoginWatch() {
  try {
    const sf = path.join(STATE_DIR, 'bili-login-watch.json');
    const last = (() => { try { return Number(JSON.parse(fs.readFileSync(sf, 'utf8')).lastCheckAt) || 0; } catch { return 0; } })();
    if (Date.now() - last < 10 * 60 * 1000) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'bili-login-watch.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}

function ensureStickerCuration() {
  try {
    const stateFile = path.join(STATE_DIR, 'sticker-curate-state.json');
    const lastRun = (() => { try { return Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastRunAt) || 0; } catch { return 0; } })();
    const interval = 12 * 60 * 60 * 1000;
    if (Date.now() - lastRun < interval) return;
    const lockFile = path.join(STATE_DIR, 'sticker-curate.lock');
    const lockPid = (() => { try { return Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch { return 0; } })();
    if (lockPid && pidAlive(lockPid)) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'sticker-curate.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起表情库整理');
  } catch {}
}

function ensureNightlyReview() {
  try {
    const pidFile = path.join(STATE_DIR, 'nightly-review.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (pid && pidAlive(pid)) return;
    const conf = readJson(CONF, {});
    if (conf.review?.enabled === false) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'nightly-review.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起夜间复盘服务 pid=' + child.pid);
  } catch (e) { log('拉起夜间复盘失败：' + (e?.message ?? e)); }
}

function ensureBrowseService() {
  try {
    const pidFile = path.join(STATE_DIR, 'browse.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (pid && pidAlive(pid)) return;
    const conf = readJson(CONF, {});
    if (conf.browse?.enabled === false) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'browse-daily.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起每日刷一刷服务 pid=' + child.pid);
  } catch (e) { log('拉起刷一刷失败：' + (e?.message ?? e)); }
}

function ensureLearnService() {
  try {
    const pidFile = path.join(STATE_DIR, 'learn-daily.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (pid && pidAlive(pid)) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'learn-daily.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起每日学习服务 pid=' + child.pid);
  } catch (e) { log('拉起每日学习失败：' + (e?.message ?? e)); }
}

function ensureRoamService() {
  try {
    const pidFile = path.join(STATE_DIR, 'live-roam.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (pid && pidAlive(pid)) return;
    const conf = readJson(CONF, {});
    if (conf.roam?.enabled === false) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'live-roam.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起巡游看播服务 pid=' + child.pid);
  } catch (e) { log('拉起巡游服务失败：' + (e?.message ?? e)); }
}

function ensureDanmakuService(live) {
  try {
    const pidFile = path.join(STATE_DIR, 'live-danmaku.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (pid && pidAlive(pid)) return;
    if (!live) return;
    const conf = readJson(CONF, {});
    if (conf.danmaku?.enabled === false) return;
    const { spawn } = childProcess;
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'live-danmaku.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起直播弹幕服务 pid=' + child.pid);
  } catch (e) { log('拉起弹幕服务失败：' + (e?.message ?? e)); }
}

const STATE_DIR = path.join(ROOT, 'qq-bridge', 'state');
const CONF = path.join(STATE_DIR, 'live-watch.json');
const LOG = path.join(ROOT, 'tools', 'live-watch.log');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const log = (m) => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };

const conf = readJson(CONF, {
  roomId: 40001,
  uid: 30001,
  name: '示例主播',
  nick: '主播',
  groups: [],
  lastStatus: null,
  lastNotifiedAt: 0,
  templates: [
    '{nick}开播了，速来',
    '{nick}开播了，直播间见',
    '直播了直播了，{nick}开播了',
  ],
});
if (!fs.existsSync(CONF)) fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');

let info;
try {
  const r = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${conf.roomId}`, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://live.bilibili.com/' },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`code ${j.code}`);
  info = j.data;
} catch (e) {
  log(`拉直播间状态失败：${e.message}`);
  process.exit(0);
}

const status = Number(info?.live_status ?? 0);
if (status === 1) { conf.lastLiveAt = Date.now(); }
if (!conf.firstSeenAt) conf.firstSeenAt = Date.now();
const title = String(info?.title ?? '');
const prev = conf.lastStatus;
conf.lastStatus = status;

// 只在"变成直播中"时喊一次；30 分钟内不重复
if (status === 1) {
  stopService(path.join(STATE_DIR, 'live-roam.pid'), '巡游');
  ensureDanmakuService(true);
  if (Date.now() - Number(conf.lastGuestRunAt || 0) > 90 * 1000) { conf.lastGuestRunAt = Date.now(); runTask('HerLiveGuest'); log('示例主播在播，优先看示例主播'); }
} else {
  stopService(path.join(STATE_DIR, 'live-danmaku.pid'), '示例主播弹幕');
  ensureRoamService();
}
ensureBrowseService();
ensureLearnService();
ensureNightlyReview();
ensureDailyLife();
ensureSelfFixWatch();
ensureHealthProbe();

if (status === 1 && Number(prev) !== 1 && Date.now() - Number(conf.lastNotifiedAt || 0) > 30 * 60 * 1000) {
  if (!conf.groups?.length) {
    log('开播了，但没配告警群（live-watch.json 的 groups 为空）');
  } else {
    const tpl = conf.templates[Math.floor(Math.random() * conf.templates.length)];
    const text = tpl.replace(/\{nick\}/g, conf.nick ?? '主播').replace(/\{name\}/g, conf.name ?? '示例主播');
    for (const gid of conf.groups) {
      const bridged = await notifyBridge({ key: 'group:' + gid, text, exempt: true });
      if (bridged.ok) {
        log(`已通知 ${gid}（via bridge，免额度）：${text}`);
        continue;
      }
      // 桥接拒绝/不可用：只记录，不回退直连（F02）。
      log(`通知 ${gid} 失败（桥接）：${bridged.error ?? 'unknown'}；不回退直连`);
    }
    conf.lastNotifiedAt = Date.now();
  }
}

fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');
log(`status=${status}（1=直播中 2=轮播 0=未开播）title=${title.slice(0, 30)}`);
