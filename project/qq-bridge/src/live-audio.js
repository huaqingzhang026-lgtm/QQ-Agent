// 直播音频：连续抓流 → 30 秒切片 → 转写（MiMo 音频理解）。
//
// 为什么用"一段 ffmpeg 持续读流 + segment 切片"而不是每 30 秒重启：
//   重启会丢边界、还会累积延迟；segment muxer 是连续读、连续写，30 秒一片，
//   片与片之间没有空档。
//
// 转写用 mimo-v2.6-flash 的 input_audio（比 mimo-v2.5-asr 按小时计费便宜得多）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function resolveLivePlayUrl(roomId) {
  const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`;
  const j = await (await fetch(url, {
    headers: { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}` },
    signal: AbortSignal.timeout(10000),
  })).json();
  const stream = j?.data?.playurl_info?.playurl?.stream?.find((s) => s?.protocol_name === 'http_stream') ?? j?.data?.playurl_info?.playurl?.stream?.[0];
  const fmt = stream?.format?.[0];
  const codec = fmt?.codec?.[0];
  const host = codec?.url_info?.[0]?.host;
  if (!host || !codec?.base_url) return '';
  return host + codec.base_url + (codec.url_info?.[0]?.extra ?? '');
}

/**
 * 启动连续抓流（30 秒一片）。返回 { child, dir, stop }。
 */
export function startAudioCapture({ ffmpegPath, url, outDir, segmentSeconds = 30, referer = 'https://live.bilibili.com' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'seg-%05d.mp3');
  const args = [
    '-v', 'error', '-y',
    '-headers', `Referer: ${referer}\r\nUser-Agent: ${UA}\r\n`,
    '-i', url,
    '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '44100', '-ac', '1',
    '-f', 'segment', '-segment_time', String(Math.max(5, segmentSeconds)), '-reset_timestamps', '1',
    pattern,
  ];
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr?.on('data', (d) => { err = (err + String(d)).slice(-2000); });
  return {
    child,
    dir: outDir,
    stop() { try { child.kill('SIGKILL'); } catch {} },
    lastError: () => err,
  };
}

export function listSegments(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^seg-\d+\.mp3$/.test(f)).sort();
  } catch { return []; }
}

/** 已经写完的切片（mtime 超过 minAgeMs），排除最新一片。 */
export function takeCompletedSegments(dir, processed, { minAgeMs = 3000, now = Date.now() } = {}) {
  const all = listSegments(dir);
  const done = [];
  for (let i = 0; i < all.length - 1; i++) {
    const f = all[i];
    if (processed.has(f)) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (now - st.mtimeMs < minAgeMs || st.size < 2000) continue;
      done.push({ name: f, file: path.join(dir, f), size: st.size });
    } catch {}
  }
  return done;
}

/** 转写一段直播音频（只输出说话内容）。 */
export async function transcribeSegment(buffer, { cfg, fetchImpl = globalThis.fetch } = {}) {
  const v = cfg?.socialV2?.vision ?? {};
  const key = cfg?.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key || !buffer?.length) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const body = {
    model: v.model || 'mimo-v2.6-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${buffer.toString('base64')}` } },
        { type: 'text', text: '这是直播里的一段音频。把里面说的话转写成中文，只输出说话内容；如果没有说话就输出空字符串。不要解释。' },
      ],
    }],
    max_completion_tokens: 300,
    thinking: { type: 'disabled' },
  };
  try {
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return '';
    const j = await res.json().catch(() => null);
    return String(j?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch { return ''; }
}


/**
 * 连续抓画面：每 intervalSeconds 秒写一帧 jpg（独立 ffmpeg 进程，读同一个直播流）。
 */
export function startFrameCapture({ ffmpegPath, url, outDir, intervalSeconds = 60, referer = 'https://live.bilibili.com' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'frame-%05d.jpg');
  const fps = 1 / Math.max(5, intervalSeconds);
  const args = [
    '-v', 'error', '-y',
    '-headers', `Referer: ${referer}\r\nUser-Agent: ${UA}\r\n`,
    '-i', url,
    '-an', '-vf', `fps=${fps.toFixed(6)}`, '-q:v', '3',
    '-f', 'image2', pattern,
  ];
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr?.on('data', (d) => { err = (err + String(d)).slice(-2000); });
  return { child, dir: outDir, stop() { try { child.kill('SIGKILL'); } catch {} }, lastError: () => err };
}

export function listFrames(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^frame-\d+\.jpg$/.test(f)).sort();
  } catch { return []; }
}

/** 取完整的新帧（排除正在写的最新一帧）。 */
export function takeNewFrames(dir, processed, { minAgeMs = 3000, now = Date.now() } = {}) {
  const all = listFrames(dir);
  const out = [];
  for (let i = 0; i < all.length - 1; i++) {
    const f = all[i];
    if (processed.has(f)) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (now - st.mtimeMs < minAgeMs || st.size < 3000) continue;
      out.push({ name: f, file: path.join(dir, f), size: st.size });
    } catch {}
  }
  return out;
}

/** 描述一帧直播画面。 */
export async function describeFrame(buffer, { cfg, fetchImpl } = {}) {
  const { describeVisuals } = await import('./vision.js');
  return describeVisuals({
    images: [{ buffer, mimeType: 'image/jpeg' }],
    prompt: '这是一张直播画面截图。用中文简短描述：画面里是谁/在做什么/场景/画面上的文字，60 字以内，不要客套。',
    cfg,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}


/** 抓单帧（每次重新连流，-frames:v 1；实测约 25 秒）。 */
export function captureSingleFrame({ ffmpegPath, url, outFile, referer = 'https://live.bilibili.com', timeoutMs = 45000 } = {}) {
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    execFileSync(ffmpegPath, [
      '-v', 'error', '-y',
      '-headers', `Referer: ${referer}\r\nUser-Agent: ${UA}\r\n`,
      '-i', url, '-an', '-frames:v', '1', '-q:v', '3', outFile,
    ], { timeout: timeoutMs, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    return fs.existsSync(outFile) && fs.statSync(outFile).size > 1000;
  } catch { return false; }
}
