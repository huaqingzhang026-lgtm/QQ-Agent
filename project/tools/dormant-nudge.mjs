// 沉寂提醒：示例主播很久没播时，在示例群提一句——**只说群友自己说过的话**（不改写、不生成）。
// 规则：距上次开播 ≥3 天；一周最多 2 次；两次间隔 ≥2 天；10~23 点之间每小时掷骰子（12%）。
import fs from 'node:fs';
import { notifyViaBridge as notifyBridge } from './lib/bridge-notify.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const LIVE = path.join(STATE, 'live-watch.json');
const CONF = path.join(STATE, 'dormant-nudge.json');
const LOG = path.join(ROOT, 'tools', 'dormant-nudge.log');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const log = (m) => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };

const conf = readJson(CONF, {
  group: '20002',
  minDaysSilent: 3,
  maxPerWeek: 2,
  minGapDays: 2,
  hourFrom: 10,
  hourTo: 23,
  perRunProbability: 0.12,
  history: [],
  quotes: [],
});
if (!Array.isArray(conf.quotes)) conf.quotes = [];

// ── 1) 先捡原话（每次跑都捡，跟要不要发无关）─────────────────────────────
try {
  const social = readJson(path.join(STATE, 'social-v2.json'), {});
  const KEY = /(开播|没播|停播|不播|直播|播了|啥时候播|什么时候播|想猫|切片|点歌|猫窝)/;
  const picked = conf.quotes.slice();
  // 两个示例主播群都当语料（都是同一批人在聊），但只发到 conf.group
  const convs = ['group:' + conf.group, 'group:20001'].map((k) => social.conversations?.[k]).filter(Boolean);
  for (const m of convs.flatMap((c) => c.recentMessages ?? [])) {
    if (m.isSelf) continue;
    const s = String(m.text ?? '').trim();
    if (s.length < 4 || s.length > 30) continue;
    if (/^\[|https?:|@/.test(s)) continue;
    if (!KEY.test(s)) continue;
    if (picked.includes(s)) continue;
    picked.push(s);
  }
  conf.quotes = picked.slice(-40);
  fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');
  log(`原话池 ${conf.quotes.length} 条`);
} catch (e) { log('捡原话失败：' + e.message); }

// ── 2) 判断该不该发 ───────────────────────────────────────────────────────
if (conf.enabled === false) { log('沉寂提醒已停用'); process.exit(0); }
const live = readJson(LIVE, {});
const now = Date.now();
if (Number(live.lastStatus) === 1) { log('正在直播，跳过'); process.exit(0); }

const lastLiveAt = Number(live.lastLiveAt ?? 0);
const firstSeenAt = Number(live.firstSeenAt ?? conf.firstSeenAt ?? 0);
const silentDays = lastLiveAt ? (now - lastLiveAt) / 86400e3 : (firstSeenAt ? (now - firstSeenAt) / 86400e3 : 0);
if (silentDays < Number(conf.minDaysSilent)) { log(`才 ${silentDays.toFixed(1)} 天没播，还不到 ${conf.minDaysSilent} 天`); process.exit(0); }

const hour = new Date().getHours();
if (hour < Number(conf.hourFrom) || hour >= Number(conf.hourTo)) { log(`不在 ${conf.hourFrom}~${conf.hourTo} 点，跳过`); process.exit(0); }

const weekAgo = now - 7 * 86400e3;
const recent = (conf.history ?? []).filter((x) => Number(x) > weekAgo);
if (recent.length >= Number(conf.maxPerWeek)) { log(`一周已发 ${recent.length} 次，到上限`); process.exit(0); }
const lastAt = Number(conf.history?.[conf.history.length - 1] ?? 0);
if (lastAt && now - lastAt < Number(conf.minGapDays) * 86400e3) { log('距上次还不到间隔'); process.exit(0); }

if (conf.quotes.length < 3) { log(`原话池只有 ${conf.quotes.length} 条，不够自然，先不发`); process.exit(0); }
if (Math.random() >= Number(conf.perRunProbability)) { log(`掷骰子没过（${conf.perRunProbability}）`); process.exit(0); }

// ── 3) 发（群友原话，一字不改）───────────────────────────────────────────
const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const text = conf.quotes[Math.floor(Math.random() * conf.quotes.length)];

// 优先走桥接的统一外发入口（S3.1）；桥接不可用时回退直连 OneBot。
async function notifyViaBridge(gid, text) {
  return notifyBridge({ key: 'group:' + gid, text, exempt: false });
}

try {
  const bridged = await notifyViaBridge(conf.group, text);
  if (!bridged.ok) {
    log(`发送失败（桥接）：${bridged.error ?? 'unknown'}；不回退直连`);
    process.exit(0);
  }
  if (bridged.ok) {
    conf.history = [...(conf.history ?? []), now].slice(-20);
    conf.lastText = text;
    fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');
    log(`已发到 ${conf.group}（via bridge）：${text}（${silentDays.toFixed(1)} 天没播）`);
    process.exit(0);
  }
} catch (e) {
  log(`发送异常：${e.message}`);
}
