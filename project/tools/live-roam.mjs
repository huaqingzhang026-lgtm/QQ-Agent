// 巡游看小主播：每天 3 小时，专挑人气低（人少）的直播间，边看边发弹幕。
//
// 规则：
//   · 每天最多 180 分钟（可配），只在 10:00–24:00 活动；
//   · 选房：从推荐列表的深页（人气低）里随机挑，人气 5~maxViewers，排除示例主播；
//   · 每个直播间最多待 20 分钟，下播/到点就换；
//   · 弹幕：每个直播间 10 条/小时；主播跟她说话后 20 条/小时；到顶发借口闭嘴；
//   · 音频 30 秒连续切片 + 每分钟 1 帧，转写/描述后进上下文。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parsePackets, extractDanmaku, decideDanmaku, noteDanmaku, excuseNeeded,
  isStreamerTalkingToHer, hourKey, DEFAULT_QUOTA,
} from '../qq-bridge/src/live-danmaku-protocol.js';
import {
  resolveLivePlayUrl, startAudioCapture, takeCompletedSegments, transcribeSegment,
  captureSingleFrame, describeFrame,
} from '../qq-bridge/src/live-audio.js';
import { pickCandidates, budgetState, shouldRotate, inActiveHours, todayKey } from '../qq-bridge/src/live-roam-lib.js';
import { addEvent } from '../qq-bridge/src/memory-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const STATE_DIR = path.join(ROOT, 'qq-bridge', 'state');
const STATE_FILE = path.join(STATE_DIR, 'live-roam.json');
const CONF_FILE = path.join(STATE_DIR, 'live-watch.json');
const COOKIE_FILE = path.join(ROOT, 'bili-mcp', 'cookie.json');
const LOG_FILE = path.join(STATE_DIR, 'live-roam.log');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WBI_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {} };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };

const conf = readJson(CONF_FILE, {});
const roam = {
  enabled: true, dailyMinutes: 600, sessionMinutes: 20, maxViewers: 1000000, minViewers: 0,
  activeStart: 10, activeEnd: 24, maxPerHour: 10, maxPerHourEngaged: 20, minGapMs: 30000,
  nameKeywords: ['Pluto', '小鲸鱼', '鲸鱼'],
  excuseLines: ['有点事，先溜了', '去忙了，晚点再来', '先撤了，你们玩'],
  ...(conf.roam ?? {}),
};
if (roam.enabled === false) { log('roam 未启用，退出'); process.exit(0); }

const DRY = process.env.LIVE_ROAM_DRY === '1';
const PID_FILE = path.join(STATE_DIR, 'live-roam.pid');
try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
process.on('exit', () => { try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {} });

const fullCfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const ffmpegPath = fullCfg?.socialV2?.voice?.ffmpegPath || '';

let state = readJson(STATE_FILE, { date: todayKey(), usedSeconds: 0, quota: {}, session: null });
let session = null; // { roomId, uid, uname, title, startedAt, ws, audio, frameTimer, context, processed, myLast }
let frameBusy = false;

function cookieHeader() {
  const c = readJson(COOKIE_FILE, {});
  if (!c.sessdata || !c.bili_jct) return '';
  return [`SESSDATA=${c.sessdata}`, `bili_jct=${c.bili_jct}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : '', c.buvid3 ? `buvid3=${c.buvid3}` : ''].filter(Boolean).join('; ');
}

async function wbiMixin() {
  const cookie = cookieHeader();
  const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com', ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(10000),
  })).json();
  const pick = (u) => String(u || '').split('/').pop()?.split('.')[0] || '';
  const raw = pick(nav?.data?.wbi_img?.img_url) + pick(nav?.data?.wbi_img?.sub_url);
  if (raw.length < 64) throw new Error('wbi key 获取失败');
  return WBI_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

async function pickRoom() {
  const mixin = await wbiMixin().catch(() => '');
  for (let attempt = 0; attempt < 6; attempt++) {
    const page = 200 + Math.floor(Math.random() * 700);
    try {
      const j = await (await fetch(`https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=${page}&page_size=30`, {
        headers: { 'user-agent': UA, referer: 'https://live.bilibili.com/' }, signal: AbortSignal.timeout(10000),
      })).json();
      const cands = pickCandidates(j?.data ?? [], {
        maxViewers: roam.maxViewers, minViewers: roam.minViewers,
        excludeUids: [String(conf.uid || ''), '30001'],
        excludeRooms: [String(conf.roomId || '40001')],
      });
      if (cands.length) {
        const interests = readJson(path.join(STATE_DIR, 'bili-interests.json'), { interests: [] }).interests || [];
        const kws = interests.flatMap((x) => String(x.name || '').split(/[\/、,，\s]+/)).filter((x) => x.length >= 2);
        const matched = kws.length ? cands.filter((c) => kws.some((k) => String(c.title || c.uname || '').includes(k))) : [];
        const pool = matched.length ? matched : cands;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        return { roomId: Number(pick.roomid), uid: String(pick.uid ?? ''), uname: String(pick.uname ?? ''), title: String(pick.title ?? ''), online: Number(pick.online) || 0 };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function roomLive(roomId) {
  try {
    const j = await (await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, { headers: { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}` }, signal: AbortSignal.timeout(8000) })).json();
    return Number(j?.data?.live_status) === 1;
  } catch { return false; }
}

async function danmuInfo(roomId) {
  const mixin = await wbiMixin();
  const params = { id: String(roomId), type: '0', wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixin).digest('hex');
  const cookie = cookieHeader();
  const j = await (await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}&w_rid=${w_rid}`, {
    headers: { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(10000),
  })).json();
  if (j.code !== 0 || !j.data?.token) throw new Error(`getDanmuInfo ${j.code}`);
  return j.data;
}

async function sendDanmaku(roomId, text) {
  const msg = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (DRY) { log('[dry] 本应发弹幕：' + msg); return { ok: true, dry: true }; }
  const cookie = cookieHeader();
  if (!msg || !cookie) return { ok: false, error: 'empty/no-cookie' };
  const c = readJson(COOKIE_FILE, {});
  const form = new URLSearchParams({ bubble: '0', color: '16777215', fontsize: '25', mode: '1', msg, rnd: String(Math.floor(Date.now() / 1000)), roomid: String(roomId), csrf: c.bili_jct, csrf_token: c.bili_jct });
  try {
    const r = await fetch('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      headers: { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, origin: 'https://live.bilibili.com', 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: form.toString(), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.code !== 0) return { ok: false, error: `code=${j.code} ${j.message ?? ''}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

async function genReply(trigger) {
  const v = fullCfg.socialV2?.vision ?? {};
  const key = fullCfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key || !session) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const heard = session.context.slice(-3).map((x) => x.text).join(' ').slice(0, 260);
  const ctx = session.context.slice(-8).map((x) => x.text).join(' ').slice(0, 400);
  const prompt = `你在 B 站小主播「${session.uname}」的直播间看直播（直播间里人不多）。账号名 Pluto，18岁女生，说话短、可爱、口语化，绝不承认自己是AI，不刷屏。
直播里最近听到/看到：${heard || '（刚进来，还没听到什么）'}
主播刚说：${trigger?.name ? `${trigger.name}：${trigger.text}` : '（无）'}
写一条弹幕，要求：不超过 20 个字、像真人随口一说；必须有具体反应点（接梗/回应某个画面或主播的话），不要空泛夸“好听/哈哈”；如果没有具体可回应的内容，只输出 [SKIP]；不要 @ 人、不要引号、不要解释。只输出弹幕文本或 [SKIP]。`;
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 80, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    const out = String(j?.choices?.[0]?.message?.content ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  if (!out || /^\[SKIP\]$/i.test(out)) return '';
  return out.slice(0, 28);
  } catch { return ''; }
}

function quotaFor(roomId) {
  const q = state.quota?.[String(roomId)] ?? {};
  return q;
}

async function speak(text, meta = {}) {
  const roomId = session?.roomId;
  if (!roomId) return false;
  const q = { maxPerHour: roam.maxPerHour, maxPerHourEngaged: roam.maxPerHourEngaged, minGapMs: roam.minGapMs, excuseLines: roam.excuseLines };
  const d = decideDanmaku({ state: quotaFor(roomId), now: Date.now(), quota: q, engagedUntil: session.engagedUntil || 0 });
  if (!d.allow) return false;
  const r = await sendDanmaku(roomId, text);
  if (!r.ok) { log(`发送失败：${r.error}`); return false; }
  const ns = noteDanmaku(quotaFor(roomId), Date.now(), text);
  state.quota = { ...(state.quota ?? {}), [String(roomId)]: ns };
  writeJson(STATE_FILE, state);
  session.myLast.push(text);
  log(`[${session.uname}] 已发弹幕(${ns.count}/${d.cap}${session.engagedUntil > Date.now() ? ' 互动中' : ''})：${text}`);
  return true;
}

async function maybeReply(trigger) {
  const roomId = session?.roomId;
  if (!roomId) return;
  const q = { maxPerHour: roam.maxPerHour, maxPerHourEngaged: roam.maxPerHourEngaged, minGapMs: roam.minGapMs, excuseLines: roam.excuseLines };
  const ex = excuseNeeded({ state: quotaFor(roomId), now: Date.now(), quota: q, engagedUntil: session.engagedUntil || 0 });
  if (ex.needed) {
    const lines = roam.excuseLines;
    const line = lines[Math.floor(Math.random() * lines.length)];
    if (await speak(line, { why: '额度到上限' })) {
      const ns = { ...quotaFor(roomId), excuseHour: ex.hour };
      state.quota = { ...(state.quota ?? {}), [String(roomId)]: ns };
      writeJson(STATE_FILE, state);
      log('额度到上限，已发借口，本房间本小时停止');
    }
    return;
  }
  const text = await genReply(trigger);
  if (text && text !== '[SKIP]') await speak(text);
}

function handleDanmaku(msg) {
  if (!session) return;
  session.recent.push(msg);
  if (session.recent.length > 60) session.recent.shift();
  const fromStreamer = String(msg.uid) === String(session.uid);
  if (fromStreamer) {
    if (isStreamerTalkingToHer({ text: msg.text, nameKeywords: roam.nameKeywords, lastHerTexts: session.myLast })) {
      session.engagedUntil = Date.now() + 10 * 60 * 1000;
      log(`主播跟她说话：${msg.text}`);
      maybeReply(msg).catch(() => {});
      return;
    }
    if (Math.random() < 0.5) maybeReply(msg).catch(() => {});
    return;
  }
  const interesting = /[?？]|主播|笑死|哈哈|可爱|怎么|为什么|有没有/.test(msg.text) && msg.text.length >= 5;
  if (interesting && Math.random() < 0.12) maybeReply(msg).catch(() => {});
}

function authPacket(token, roomId) {
  const c = readJson(COOKIE_FILE, {});
  const body = Buffer.from(JSON.stringify({ uid: Number(c.dede_user_id) || 0, roomid: roomId, protover: 3, platform: 'web', type: 2, key: token, buvid: String(c.buvid3 || ''), clientver: '1.13.0' }), 'utf8');
  const buf = Buffer.alloc(16 + body.length);
  buf.writeUInt32BE(16 + body.length, 0); buf.writeUInt16BE(16, 4); buf.writeUInt16BE(1, 6); buf.writeUInt32BE(7, 8); buf.writeUInt32BE(1, 12);
  body.copy(buf, 16);
  return buf;
}
function heartbeatPacket() {
  const body = Buffer.from('[object Object]', 'utf8');
  const buf = Buffer.alloc(16 + body.length);
  buf.writeUInt32BE(16 + body.length, 0); buf.writeUInt16BE(16, 4); buf.writeUInt16BE(1, 6); buf.writeUInt32BE(2, 8); buf.writeUInt32BE(1, 12);
  body.copy(buf, 16);
  return buf;
}

async function startSession(room) {
  session = { ...room, startedAt: Date.now(), context: [], recent: [], myLast: [], engagedUntil: 0, ws: null, audio: null, frameTimer: null, processed: new Set() };
  log(`进入直播间 ${room.roomId}「${room.uname}」人气=${room.online} 标题=${room.title.slice(0, 30)}`);
  try {
    const url = await resolveLivePlayUrl(room.roomId);
    if (url) {
      session.audio = startAudioCapture({ ffmpegPath, url, outDir: path.join(STATE_DIR, 'roam-audio'), segmentSeconds: 30, referer: `https://live.bilibili.com/${room.roomId}` });
      session.audioTimer = setInterval(() => pollAudio(), 3000);
      log('开始录音（30s/片）');
    }
    const info = await danmuInfo(room.roomId);
    const host = info.host_list?.[0];
    if (host) {
      const ws = new WebSocket(`wss://${host.host}:${host.wss_port}/sub`);
      session.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { ws.send(authPacket(info.token, room.roomId)); session.hb = setInterval(() => { try { ws.send(heartbeatPacket()); } catch {} }, 30000); };
      ws.onmessage = (ev) => {
        try {
          for (const p of parsePackets(Buffer.from(ev.data))) {
            if (p.op !== 5) continue;
            let obj; try { obj = JSON.parse(p.body.toString('utf8')); } catch { continue; }
            const d = extractDanmaku(obj);
            if (d) handleDanmaku(d);
          }
        } catch {}
      };
      ws.onclose = () => { clearInterval(session?.hb); };
    }
    // 每分钟一帧
    for (let i = 0; i < 1; i++) {
      session.frameTimer = setInterval(async () => {
        if (!session || frameBusy) return;
        frameBusy = true;
        const file = path.join(STATE_DIR, 'roam-frames', `f-${Date.now()}.jpg`);
        try {
          if (captureSingleFrame({ ffmpegPath, url, outFile: file, referer: `https://live.bilibili.com/${room.roomId}` })) {
            const desc = await describeFrame(fs.readFileSync(file), { cfg: fullCfg });
            if (desc) { session.context.push({ text: '画面：' + desc }); if (session.context.length > 20) session.context.shift(); try { addEvent({ source: 'live', conversationKey: 'live:' + session.roomId, actorId: 'live', actorName: session.uname, kind: 'live-frame', text: '画面：' + desc, importance: 0.45, confidence: 0.7 }); } catch {} log('画面：' + desc.slice(0, 70)); }
          }
        } catch {} finally { try { fs.unlinkSync(file); } catch {} frameBusy = false; }
      }, 60000);
    }
  } catch (e) { log('进入直播间失败：' + (e?.message ?? e)); }
}

async function pollAudio() {
  if (!session?.audio) return;
  const dir = path.join(STATE_DIR, 'roam-audio');
  const done = takeCompletedSegments(dir, session.processed);
  for (const seg of done) {
    session.processed.add(seg.name);
    try {
      const buf = fs.readFileSync(seg.file);
      const text = await transcribeSegment(buf, { cfg: fullCfg });
      try { fs.unlinkSync(seg.file); } catch {}
      if (text) { session.context.push({ text }); if (session.context.length > 20) session.context.shift(); try { addEvent({ source: 'live', conversationKey: 'live:' + session.roomId, actorId: 'live', actorName: session.uname, kind: 'live-audio', text, importance: 0.5, confidence: 0.65 }); } catch {} log('听到：' + text.slice(0, 70)); }
    } catch {}
  }
}

function endSession(reason) {
  if (!session) return;
  log(`离开直播间「${session.uname}」（${reason}）`);
  try { session.ws?.close(); } catch {}
  clearInterval(session.hb); clearInterval(session.audioTimer); clearInterval(session.frameTimer);
  try { session.audio?.stop(); } catch {}
  session = null;
}

async function tick() {
  const now = Date.now();
  const b = budgetState(state, { dailyMinutes: roam.dailyMinutes, now });
  if (!inActiveHours(now, { start: roam.activeStart, end: roam.activeEnd }) || b.exhausted) {
    if (session) endSession('到点/额度用完');
    state.session = null; writeJson(STATE_FILE, state);
    return;
  }
  if (!session) {
    const room = await pickRoom();
    if (!room) { log('暂时没找到合适的小主播，稍后再试'); return; }
    await startSession(room);
    state.session = { roomId: room.roomId, uid: room.uid, uname: room.uname, startedAt: session?.startedAt ?? now };
    writeJson(STATE_FILE, state);
    return;
  }
  const live = await roomLive(session.roomId);
  if (shouldRotate({ session, now, sessionMinutes: roam.sessionMinutes, roomLive: live })) {
    endSession(live ? '到时间换台' : '下播了');
    state.session = null; writeJson(STATE_FILE, state);
  }
}

// 每天计时：每 30 秒累加（只在有 session 时）
setInterval(() => {
  if (!session) return;
  const day = todayKey();
  if (state.date !== day) { state = { date: day, usedSeconds: 0, quota: {}, session: null }; }
  state.usedSeconds = (Number(state.usedSeconds) || 0) + 30;
  state.session = session ? { roomId: session.roomId, uid: session.uid, uname: session.uname, startedAt: session.startedAt } : null;
  writeJson(STATE_FILE, state);
}, 30000);

log(`live-roam 启动：每天 ${roam.dailyMinutes} 分钟，单台 ${roam.sessionMinutes} 分钟，人气 ≤${roam.maxViewers}，活动 ${roam.activeStart}:00-${roam.activeEnd}:00`);
setTimeout(tick, 5000);
setInterval(tick, 60000);
