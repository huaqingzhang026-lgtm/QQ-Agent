// 真正“看”一条 B 站视频：取低清流 → 抽 4 帧 → 视觉模型描述 → 缓存。
//
// B 站视频没有直接给视觉模型的 URL；这里只取最小的 DASH 视频流（360p/480p），
// 限制大小，避免把整段高清视频拉下来。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { extractVideoFrames } from '../qq-bridge/src/media-frames.js';
import { describeVisuals } from '../qq-bridge/src/vision.js';
import { transcribeAudio } from '../qq-bridge/src/asr.js';
import { isLikelyMusicTranscript } from './bili-link.mjs';

const SEVEN_PROMPT = `你是 Pluto，正在认真看一条 B 站视频。按固定七段式输出，不要只复述字幕：\n1. 一句话概括\n2. 画面关键场景（至少 3 个，写实际看到的人物/物体/动作/文字）\n3. 作者主张（他想让观众相信什么）\n4. 事实与观点分开（哪些是画面事实，哪些是作者判断）\n5. 评论区/弹幕反应（没有就给“暂无”）\n6. 你自己的判断（喜欢/无聊/不同意，给具体理由）\n7. 是否值得收藏/评论\n每段一行，总字数 350 以内。`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };

function cookieHeader(root) {
  const c = readJson(path.join(root, 'bili-mcp', 'cookie.json'), {});
  if (!c.sessdata) return '';
  return `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct ?? ''}; DedeUserID=${c.dede_user_id ?? ''}`;
}

async function getJson(url, referer, cookie) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(20000) });
  return r.json();
}

export async function summarizeBiliVideo({ root, bvid, title = '', cfg, stateDir, log = () => {} }) {
  const cacheFile = path.join(stateDir, 'bili-video-summaries.json');
  const cache = readJson(cacheFile, {});
  const today = new Date().toISOString().slice(0, 10);
  if (cache[bvid]?.date === today && cache[bvid]?.summary) return cache[bvid].summary;

  const cookie = cookieHeader(root);
  const referer = `https://www.bilibili.com/video/${bvid}`;
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, 'https://www.bilibili.com', cookie);
  const d = view?.data;
  if (!d?.cid) return '';
  const duration = Number(d.duration) || 0;
  if (duration > 1800) { log('B站视频太长，跳过画面：' + bvid); return ''; }

  const play = await getJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${d.cid}&fnval=16&qn=16`, referer, cookie);
  const videos = (play?.data?.dash?.video ?? []).slice().sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0));
  const stream = videos.find((v) => Number(v.height) <= 480) ?? videos[0];
  if (!stream?.baseUrl) { log('B站没有可用视频流：' + bvid); return ''; }

  const audioStream = (play?.data?.dash?.audio ?? []).slice().sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0))[0];
  let transcript = '';
  try {
    if (audioStream?.baseUrl) {
      const ar = await fetch(audioStream.baseUrl, { headers: { 'user-agent': UA, referer, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(60000) });
      if (ar.ok) {
        const abuf = Buffer.from(await ar.arrayBuffer());
        if (abuf.length <= 20 * 1024 * 1024) {
          const ff = cfg?.socialV2?.voice?.ffmpegPath;
          if (ff) {
            const mp3 = spawnSync(ff, ['-y', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { input: abuf, maxBuffer: 12 * 1024 * 1024, timeout: 90000, windowsHide: true });
            if (mp3.status === 0 && mp3.stdout?.length) transcript = String(await transcribeAudio({ buffer: Buffer.from(mp3.stdout), cfg }) || '').trim();
          }
        }
      }
    }
  } catch {}
  if (transcript) log('B站视频语音转写 ' + transcript.length + ' 字：' + bvid);
  const cap = 48 * 1024 * 1024;
  const r = await fetch(stream.baseUrl, { headers: { 'user-agent': UA, referer, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) { log('B站视频下载失败 ' + bvid + ' HTTP ' + r.status); return ''; }
  const len = Number(r.headers.get('content-length') || 0);
  if (len && len > cap) { log('B站视频超过 48MB，跳过画面：' + bvid); return ''; }
  const buffer = Buffer.from(await r.arrayBuffer());
  if (buffer.length > cap) { log('B站视频超过 48MB，跳过画面：' + bvid); return ''; }

  const ffmpegPath = cfg?.socialV2?.voice?.ffmpegPath;
  if (!ffmpegPath) return '';
  let summary = '';
  // 优先把低清流 remux 成 mp4，直接交给支持原生视频的 MiMo；失败/太大再抽帧。
  const maxNative = Math.max(1, Math.min(80, Number(cfg?.socialV2?.vision?.maxVideoBytes) || 20)) * 1024 * 1024;
  if (buffer.length <= maxNative) {
    const tmp = path.join(os.tmpdir(), 'bili-' + bvid + '-' + Date.now() + '.mp4');
    try {
      const r = spawnSync(ffmpegPath, ['-y', '-i', 'pipe:0', '-c', 'copy', '-movflags', '+faststart', tmp], { input: buffer, timeout: 90000, windowsHide: true });
      if (r.status === 0 && fs.existsSync(tmp)) {
        const mp4 = fs.readFileSync(tmp);
        summary = await describeVisuals({ video: { buffer: mp4, mimeType: 'video/mp4' }, kind: 'video', cfg, prompt: SEVEN_PROMPT }) || '';
        if (summary) log('B站视频原生理解：' + bvid);
      }
    } catch (e) { log('B站原生视频失败，抽帧兜底：' + (e?.message ?? e)); }
    finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} }
  }
  if (!summary) {
    let frames = [];
    try {
      frames = extractVideoFrames(buffer, { ffmpegPath, count: 6, width: 640 }).frames ?? [];
    } catch (e) { log('B站抽帧失败 ' + bvid + '：' + (e?.message ?? e)); return ''; }
    if (!frames.length) return '';
    try { const frameDir = path.join(stateDir, 'bili-frames'); fs.mkdirSync(frameDir, { recursive: true }); if (frames[0]?.buffer) fs.writeFileSync(path.join(frameDir, bvid + '.jpg'), frames[0].buffer); } catch {}
    summary = await describeVisuals({ images: frames.map((f) => ({ buffer: f.buffer, mimeType: f.mimeType })), kind: 'video', cfg, prompt: SEVEN_PROMPT }) || '';
    if (summary) log('B站视频抽帧理解：' + bvid);
  }
  if (!summary) return '';


  const full = transcript ? summary + '\n【语音】' + transcript.slice(0, 1200) : summary;
  cache[bvid] = { date: today, title: String(title || d.title || ''), duration, summary: full.slice(0, 1600), at: Date.now() };
  writeJson(cacheFile, cache);
  log('B站视频已看懂：' + bvid + '（' + Math.round(buffer.length / 1024 / 1024) + 'MB）');
  return cache[bvid].summary;
}
