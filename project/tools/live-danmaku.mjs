// 陪看直播 + 发弹幕（示例主播）。
//
// 规则（2026-10-23）：
//   · 平时每小时最多 10 条弹幕；
//   · 主播跟她说话后 10 分钟内，上限 20 条/小时（仍然只回主播/聊直播内容）；
//   · 到上限：发一条"有点事先溜了"之类的借口，然后这一小时闭嘴；
//   · 最小间隔 30 秒；不刷屏、不发无意义字符。
//
// 数据：B站公开弹幕 WS（需要 WBI 签名拿 token）+ bili-mcp/cookie.json 登录态发弹幕。
// 不依赖 bili-mcp 进程；额度独立记在 qq-bridge/state/live-danmaku.json。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parsePackets, extractDanmaku, decideDanmaku, noteDanmaku, excuseNeeded,
  isStreamerTalkingToHer, hourKey, DEFAULT_QUOTA,
} from '../qq-bridge/src/live-danmaku-protocol.js';
import { resolveLivePlayUrl, startAudioCapture, takeCompletedSegments, transcribeSegment, captureSingleFrame, describeFrame } from '../qq-bridge/src/live-audio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const STATE_DIR = path.join(ROOT, 'qq-bridge', 'state');
const STATE_FILE = path.join(STATE_DIR, 'live-danmaku.json');
const CONF_FILE = path.join(STATE_DIR, 'live-watch.json');
const COOKIE_FILE = path.join(ROOT, 'bili-mcp', 'cookie.json');
const LOG_FILE = path.join(STATE_DIR, 'live-danmaku.log');
const PID_FILE = path.join(STATE_DIR, 'live-danmaku.pid');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WBI_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };

const conf = readJson(CONF_FILE, {});
const roomId = Number(process.env.LIVE_ROOM_OVERRIDE || conf.roomId || 0);
const streamerUid = String(conf.uid || '');
const cfg = { ...DEFAULT_QUOTA, ...(conf.danmaku ?? {}) };
if (conf.danmaku?.enabled === false || !roomId) { log('未启用或没有 roomId，退出'); process.exit(0); }

let state = readJson(STATE_FILE, { hourKey: '', count: 0, lastAt: 0, excuseHour: '' });
let engagedUntil = 0;
const recent = [];
const myLast = [];
let ws = null;
let heartbeat = null;
let closing = false;
let audio = null;
let pollTimer = null;
const processed = new Set();
const streamContext = [];
const fullCfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const ffmpegPath = fullCfg?.socialV2?.voice?.ffmpegPath || '';

// ── 登录态 ────────────────────────────────────────────────────────────────
function cookieHeader() {
  const c = readJson(COOKIE_FILE, {});
  if (!c.sessdata || !c.bili_jct) return '';
  return [`SESSDATA=${c.sessdata}`, `bili_jct=${c.bili_jct}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : '', c.buvid3 ? `buvid3=${c.buvid3}` : ''].filter(Boolean).join('; ');
}

async function wbiKeys() {
  const cookie = cookieHeader();
  const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(10000),
  })).json();
  const pick = (u) => String(u || '').split('/').pop()?.split('.')[0] || '';
  const raw = pick(nav?.data?.wbi_img?.img_url) + pick(nav?.data?.wbi_img?.sub_url);
  if (raw.length < 64) throw new Error('无法获取 wbi key');
  return WBI_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

async function danmuInfo() {
  const mixin = await wbiKeys();
  const params = { id: String(roomId), type: '0', wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixin).digest('hex');
  const cookie = cookieHeader();
  const j = await (await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}&w_rid=${w_rid}`, {
    headers: { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(10000),
  })).json();
  if (j.code !== 0 || !j.data?.token) throw new Error(`getDanmuInfo 失败 code=${j.code} ${j.message ?? ''}`);
  return j.data;
}

async function isLive() {
  try {
    const j = await (await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
      headers: { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}` },
      signal: AbortSignal.timeout(8000),
    })).json();
    return Number(j?.data?.live_status) === 1;
  } catch { return false; }
}

// ── 发弹幕 ────────────────────────────────────────────────────────────────
async function sendDanmaku(text) {
  const msg = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!msg) return { ok: false, error: 'empty' };
  const cookie = cookieHeader();
  if (!cookie) return { ok: false, error: '没有登录态' };
  const c = readJson(COOKIE_FILE, {});
  const form = new URLSearchParams({
    bubble: '0', color: '16777215', fontsize: '25', mode: '1',
    msg, rnd: String(Math.floor(Date.now() / 1000)),
    roomid: String(roomId), csrf: c.bili_jct, csrf_token: c.bili_jct,
  });
  try {
    const r = await fetch('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      headers: {
        'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, origin: 'https://live.bilibili.com',
        'content-type': 'application/x-www-form-urlencoded', cookie,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.code !== 0) return { ok: false, error: `code=${j.code} ${j.message ?? ''}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── 生成回复（MiMo flash 文本） ────────────────────────────────────────────
async function genReply(trigger) {
  const c = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
  const v = c.socialV2?.vision ?? {};
  const key = c.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const ctx = recent.slice(-12).map((m) => `${m.name}：${m.text}`).join('\n');
  const heard = streamContext.slice(-3).map((s) => s.text).join(' ').slice(0, 300);
  const prompt = `直播里最近说的话：${heard || '（还没听到）'}\n\n你在示例主播的直播间看直播，账号名是 Pluto（18岁女生，说话短、可爱、口语化，绝不承认自己是AI，不刷屏）。
最近弹幕：
${ctx}
主播刚说：${trigger?.name ? `${trigger.name}：${trigger.text}` : '（无）'}
写一条弹幕回应，要求：不超过 20 个字、像真人随口一说、可以接梗/吐槽/夸主播/回答问题；不要 @ 人、不要引号、不要解释。只输出弹幕文本。`;
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 80, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    return String(j?.choices?.[0]?.message?.content ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 28);
  } catch { return ''; }
}

// ── 发送（含额度） ────────────────────────────────────────────────────────
async function speak(text, meta = {}) {
  const d = decideDanmaku({ state, now: Date.now(), quota: cfg, engagedUntil });
  if (!d.allow) { log(`不发（${d.reason}，${d.used}/${d.cap}）`); return false; }
  const r = await sendDanmaku(text);
  if (!r.ok) { log(`发送失败：${r.error}`); return false; }
  state = noteDanmaku(state, Date.now(), text);
  writeJson(STATE_FILE, state);
  myLast.push(text);
  log(`已发弹幕(${state.count}/${d.cap}${engagedUntil > Date.now() ? ' 主播互动中' : ''})：${text} ${meta.why ?? ''}`);
  return true;
}

async function maybeExcuseOrReply(trigger) {
  const ex = excuseNeeded({ state, now: Date.now(), engagedUntil, quota: cfg });
  if (ex.needed) {
    const lines = cfg.excuseLines?.length ? cfg.excuseLines : DEFAULT_QUOTA.excuseLines;
    const line = lines[Math.floor(Math.random() * lines.length)];
    if (await speak(line, { why: '（额度到上限，借口离开）' })) {
      state.excuseHour = ex.hour;
      writeJson(STATE_FILE, state);
      log('额度到上限，已发借口，本小时停止弹幕');
    }
    return;
  }
  const text = await genReply(trigger);
  if (!text) return;
  await speak(text, { why: trigger ? '（回主播）' : '（跟弹幕）' });
}


async function ensureAudio() {
  if (audio || !ffmpegPath) return;
  try {
    const url = await resolveLivePlayUrl(roomId);
    if (!url) return;
    const dir = path.join(STATE_DIR, 'live-audio');
    audio = startAudioCapture({ ffmpegPath, url, outDir: dir, segmentSeconds: 30, referer: `https://live.bilibili.com/${roomId}` });
    pollTimer = setInterval(pollAudio, 3000);
    log('开始连续录音（30 秒/片，无缝切片）');
    startFrameLoop(url);
  } catch (e) { log('启动录音失败：' + (e?.message ?? e)); }
}

function stopAudio() {
  try { audio?.stop(); } catch {}
  audio = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  processed.clear();
  streamContext.length = 0;
}

async function pollAudio() {
  if (!audio) return;
  const dir = path.join(STATE_DIR, 'live-audio');
  const done = takeCompletedSegments(dir, processed);
  for (const seg of done) {
    processed.add(seg.name);
    try {
      const buf = fs.readFileSync(seg.file);
      const text = await transcribeSegment(buf, { cfg: fullCfg });
      try { fs.unlinkSync(seg.file); } catch {}
      if (text) {
        streamContext.push({ at: Date.now(), text });
        if (streamContext.length > 20) streamContext.shift();
        log('听到：' + text.slice(0, 70));
      }
    } catch (e) { log('转写失败：' + (e?.message ?? e)); }
  }
  if (audio && audio.child.exitCode !== null) {
    log('录音进程退出，5 秒后重连');
    stopAudio();
    setTimeout(ensureAudio, 5000);
  }
}


let frameTimer = null;
let frameBusy = false;
let currentStreamUrl = '';

function startFrameLoop(url) {
  currentStreamUrl = url;
  if (frameTimer) return;
  const tick = async () => {
    if (frameBusy || !currentStreamUrl) return;
    frameBusy = true;
    const file = path.join(STATE_DIR, 'live-frames', `frame-${Date.now()}.jpg`);
    try {
      const ok = captureSingleFrame({ ffmpegPath, url: currentStreamUrl, outFile: file, referer: `https://live.bilibili.com/${roomId}` });
      if (ok) {
        const desc = await describeFrame(fs.readFileSync(file), { cfg: fullCfg });
        if (desc) {
          streamContext.push({ at: Date.now(), text: '画面：' + desc });
          if (streamContext.length > 20) streamContext.shift();
          log('画面：' + desc.slice(0, 70));
        }
      }
    } catch (e) { log('抓帧失败：' + (e?.message ?? e)); }
    finally {
      try { fs.unlinkSync(file); } catch {}
      frameBusy = false;
    }
  };
  frameTimer = setInterval(tick, 60000);
  setTimeout(tick, 8000);
  log('开始每分钟抓 1 帧画面');
}

function stopFrameLoop() {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
  frameBusy = false;
  currentStreamUrl = '';
}

// ── WS ────────────────────────────────────────────────────────────────────
function authPacket(token) {
  const c = readJson(COOKIE_FILE, {});
  const body = Buffer.from(JSON.stringify({
    uid: Number(c.dede_user_id) || 0,
    roomid: roomId,
    protover: 3,
    platform: 'web',
    type: 2,
    key: token,
    buvid: String(c.buvid3 || ''),
    clientver: '1.13.0',
  }), 'utf8');
  const buf = Buffer.alloc(16 + body.length);
  buf.writeUInt32BE(16 + body.length, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(7, 8);
  buf.writeUInt32BE(1, 12);
  body.copy(buf, 16);
  return buf;
}

function heartbeatPacket() {
  const body = Buffer.from('[object Object]', 'utf8');
  const buf = Buffer.alloc(16 + body.length);
  buf.writeUInt32BE(16 + body.length, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(2, 8);
  buf.writeUInt32BE(1, 12);
  body.copy(buf, 16);
  return buf;
}

function handleDanmaku(msg) {
  recent.push(msg);
  if (recent.length > 60) recent.shift();
  const fromStreamer = String(msg.uid) === streamerUid;
  if (fromStreamer) {
    if (isStreamerTalkingToHer({ text: msg.text, nameKeywords: cfg.nameKeywords ?? [], lastHerTexts: myLast })) {
      engagedUntil = Date.now() + (Number(cfg.engagedWindowMs) || DEFAULT_QUOTA.engagedWindowMs);
      log(`主播跟她说话：${msg.text}（互动窗口 10 分钟）`);
      maybeExcuseOrReply(msg).catch(() => {});
      return;
    }
    // 主播没点名：也接一句，但频率低一点
    if (Math.random() < 0.35) maybeExcuseOrReply(msg).catch(() => {});
    return;
  }
  // 普通弹幕：只在小概率、且是有内容的句子时接
  const interesting = /[?？]|主播|笑死|哈哈|可爱|怎么|为什么|有没有/.test(msg.text) && msg.text.length >= 5;
  if (interesting && Math.random() < (Number(cfg.replyProbability) || 0.08)) {
    maybeExcuseOrReply(msg).catch(() => {});
  }
}

async function connect() {
  if (closing) return;
  try {
    const info = await danmuInfo();
    const host = info.host_list?.[0];
    if (!host) throw new Error('没有可用弹幕服务器');
    const url = `wss://${host.host}:${host.wss_port}/sub`;
    log(`连接弹幕服务器 ${url}`);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(authPacket(info.token));
      heartbeat = setInterval(() => { try { ws?.send(heartbeatPacket()); } catch {} }, 30000);
      log('弹幕 WS 已连接');
    };
    ws.onmessage = (ev) => {
      try {
        const buf = Buffer.from(ev.data);
        for (const p of parsePackets(buf)) {
          if (p.op !== 5) continue;
          let obj; try { obj = JSON.parse(p.body.toString('utf8')); } catch { continue; }
          const d = extractDanmaku(obj);
          if (d) handleDanmaku(d);
        }
      } catch {}
    };
    ws.onclose = () => { clearInterval(heartbeat); ws = null; log('WS 关闭，5 秒后重连'); setTimeout(connect, 5000); };
    ws.onerror = () => { try { ws?.close(); } catch {} };
  } catch (e) {
    log(`连接失败：${e?.message ?? e}，30 秒后重试`);
    setTimeout(connect, 30000);
  }
}

const FORCE = process.env.LIVE_DANMAKU_FORCE === '1';

async function loop() {
  const live = FORCE || await isLive();
  if (live && !ws) { log('检测到开播，开始听弹幕'); connect(); ensureAudio(); }
  if (!live && (ws || audio || frameTimer)) { stopAudio(); stopFrameLoop(); log('已下播，停止录音与弹幕'); closing = true; try { ws.close(); } catch {} ws = null; clearInterval(heartbeat); closing = false; }
  setTimeout(loop, 60000);
}

try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
process.on('exit', () => { try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {} });
log(`live-danmaku 启动（房间 ${roomId}，主播 ${streamerUid}，上限 ${cfg.maxPerHour}/${cfg.maxPerHourEngaged} 每小时）`);
loop();
