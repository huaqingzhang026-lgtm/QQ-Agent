// 视频抽帧 / 图片归一化（媒体理解优化）。
//
// 背景：桥接原来只把视频记成字符串 "[视频]"，模型完全看不到画面；大图也原样塞给模型，
// 既慢又容易被压缩得看不清。这里用本机 ffmpeg 做两件事：
//   · 视频：按时间均匀抽 N 帧（默认 4 帧、宽 640）→ 作为图片一起送给模型；
//   · 图片：超过 maxSide 的长边先缩到 1568（DeepSeek 视觉编码器常用尺寸），转 JPEG。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function run(ffmpeg, args, timeout = 30000) {
  execFileSync(ffmpeg, args, { timeout, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
}

export function probeDurationSeconds(file, ffprobe) {
  try {
    const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    const d = Number(JSON.parse(out)?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

/**
 * 从视频缓冲抽帧。
 * @returns {{frames: Array<{buffer: Buffer, mimeType: string}>, duration: number}}
 */
export function extractVideoFrames(buffer, { ffmpegPath, ffprobePath, count = 4, width = 640 } = {}) {
  const frames = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-'));
  const input = path.join(dir, 'in.mp4');
  try {
    fs.writeFileSync(input, buffer);
    const probe = ffprobePath || path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const duration = probeDurationSeconds(input, probe);
    const n = Math.max(1, Math.min(6, Number(count) || 4));
    if (!duration) {
      // 探不到时长：退化为按 fps 抓第一帧
      const out = path.join(dir, 'f-0.jpg');
      run(ffmpegPath, ['-v', 'error', '-y', '-i', input, '-vf', `scale=${width}:-2`, '-frames:v', '1', out]);
      if (fs.existsSync(out)) frames.push({ buffer: fs.readFileSync(out), mimeType: 'image/jpeg' });
      return { frames, duration: 0 };
    }
    for (let i = 0; i < n; i++) {
      const at = Math.max(0, Math.min(duration - 0.05, duration * ((i + 0.5) / n)));
      const out = path.join(dir, `f-${i}.jpg`);
      try {
        run(ffmpegPath, ['-v', 'error', '-y', '-ss', String(at), '-i', input, '-vf', `scale=${width}:-2`, '-frames:v', '1', '-q:v', '3', out]);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) frames.push({ buffer: fs.readFileSync(out), mimeType: 'image/jpeg' });
      } catch { /* 单帧失败就跳过 */ }
    }
    return { frames, duration };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** 超过 maxSide 的长边时缩图并转 JPEG；小图原样返回。 */
export function normalizeImage(buffer, mimeType, { ffmpegPath, maxSide = 1568, quality = 3 } = {}) {
  if (!buffer || !mimeType || !String(mimeType).startsWith('image/')) return { buffer, mimeType };
  if (String(mimeType).includes('gif')) return { buffer, mimeType }; // GIF 由模型直接看帧序列
  if (buffer.length <= 1200 * 1024) return { buffer, mimeType };
  if (!ffmpegPath) return { buffer, mimeType };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-img-'));
  const input = path.join(dir, 'in');
  const output = path.join(dir, 'out.jpg');
  try {
    fs.writeFileSync(input, buffer);
    // 只缩不放：iw>maxSide 时才缩，否则保持原尺寸。
    run(ffmpegPath, ['-v', 'error', '-y', '-i', input, '-vf', `scale='min(${maxSide},iw)':-2`, '-q:v', String(quality), output]);
    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
      return { buffer: fs.readFileSync(output), mimeType: 'image/jpeg' };
    }
  } catch { /* 失败就用原图 */ }
  finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return { buffer, mimeType };
}


/**
 * 压缩视频到目标体积（必要时降低分辨率/码率/帧率）。
 * @returns {Buffer|null} 压缩后的 mp4；失败返回 null
 */
export function compressVideo(buffer, { ffmpegPath, maxBytes = 100 * 1024 * 1024, height = 720, fps = 2 } = {}) {
  if (!buffer || !ffmpegPath) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vcomp-'));
  const input = path.join(dir, 'in.mp4');
  try {
    fs.writeFileSync(input, buffer);
    const passes = [
      { height, fps, crf: 30, bitrate: null },
      { height: 480, fps: 1, crf: 34, bitrate: '500k' },
    ];
    for (const pass of passes) {
      const out = path.join(dir, `out-${pass.crf}.mp4`);
      const vf = `scale=-2:'min(${pass.height},ih)',fps=${pass.fps}`;
      const args = ['-v', 'error', '-y', '-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(pass.crf)];
      if (pass.bitrate) args.push('-maxrate', pass.bitrate, '-bufsize', '1M');
      args.push('-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out);
      try {
        run(ffmpegPath, args, 120000);
        if (fs.existsSync(out)) {
          const buf = fs.readFileSync(out);
          if (buf.length <= maxBytes) return buf;
        }
      } catch { /* 下一档 */ }
    }
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** 按时长切片，返回前 maxChunks 段。 */
export function splitVideo(buffer, { ffmpegPath, chunkSeconds = 120, maxChunks = 3 } = {}) {
  if (!buffer || !ffmpegPath) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vsplit-'));
  const input = path.join(dir, 'in.mp4');
  try {
    fs.writeFileSync(input, buffer);
    const pattern = path.join(dir, 'part-%03d.mp4');
    run(ffmpegPath, ['-v', 'error', '-y', '-i', input, '-c', 'copy', '-f', 'segment', '-segment_time', String(Math.max(10, chunkSeconds)), '-reset_timestamps', '1', pattern], 120000);
    const files = fs.readdirSync(dir).filter((f) => /^part-\d+\.mp4$/.test(f)).sort().slice(0, Math.max(1, maxChunks));
    return files.map((f) => fs.readFileSync(path.join(dir, f)));
  } catch {
    return [];
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 视频处理计划：太长跳过；超限先压缩，仍超限再切片；绝不退回"抽帧"。
 * @returns {{chunks: Buffer[], compressed: boolean, skipped: boolean, reason: string}}
 */
export function planVideo({ buffer, durationSec = 0, ffmpegPath, maxBytes = 100 * 1024 * 1024, maxDurationSec = 600, maxChunks = 3, chunkSeconds = 120 } = {}) {
  if (!buffer) return { chunks: [], compressed: false, skipped: true, reason: 'no-buffer' };
  if (durationSec > maxDurationSec) return { chunks: [], compressed: false, skipped: true, reason: 'too-long' };
  if (buffer.length <= maxBytes) return { chunks: [buffer], compressed: false, skipped: false, reason: 'native' };
  const compressed = compressVideo(buffer, { ffmpegPath, maxBytes });
  if (compressed && compressed.length <= maxBytes) return { chunks: [compressed], compressed: true, skipped: false, reason: 'compressed' };
  const parts = splitVideo(compressed || buffer, { ffmpegPath, chunkSeconds, maxChunks });
  if (parts.length) return { chunks: parts, compressed: true, skipped: false, reason: 'split' };
  return { chunks: [], compressed: false, skipped: true, reason: 'compress-failed' };
}


/** 探测内存中视频的时长（写临时文件后 ffprobe）。 */
export function probeDurationBuffer(buffer, ffprobePath) {
  if (!buffer || !ffprobePath) return 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vprobe-'));
  const file = path.join(dir, 'in.mp4');
  try {
    fs.writeFileSync(file, buffer);
    return probeDurationSeconds(file, ffprobePath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
