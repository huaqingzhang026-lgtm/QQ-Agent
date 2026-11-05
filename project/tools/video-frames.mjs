// 把一段视频摊成「每 N 秒一张图」，给她用眼睛看。
//
// 她听不见、也放不了视频，但能读图（read_image）。所以「理解视频」的现实做法是：
//   1) 先把视频下到本地（B 站：bilibili_video_download 工具）
//   2) 用这个脚本抽帧
//   3) 逐张 read_image + 结合字幕/弹幕/评论
//
// 用法：
//   node tools\video-frames.mjs --input "D:\dl\xxx.mp4"
//   node tools\video-frames.mjs --input xxx.mp4 --every 20 --max 30 --width 1280
//   node tools\video-frames.mjs --input xxx.mp4 --audio          # 顺手抽一条 16k 单声道 wav（给以后转写用）
//   node tools\video-frames.mjs --input xxx.mp4 --scene 0.35     # 改成按镜头切换抽帧
//
// 输出：<out>\frame-001.jpg ... + manifest.json，并在 stdout 打印每张的绝对路径。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const input = arg('input');
if (!input || input === true) {
  console.error('用法：node tools\\video-frames.mjs --input <视频文件> [--every 30] [--max 24] [--width 960] [--audio] [--scene 0.35]');
  process.exit(1);
}
const src = path.resolve(ROOT, String(input));
if (!fs.existsSync(src)) { console.error(`找不到视频：${src}`); process.exit(1); }

const every = Math.max(1, Number(arg('every', 30)));
const maxFrames = Math.max(1, Math.min(200, Number(arg('max', 24))));
const width = Math.max(320, Number(arg('width', 960)));
const scene = arg('scene', null);
const wantAudio = process.argv.includes('--audio');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(ROOT, String(arg('out', path.join('agent-home', 'notes', 'frames', `${path.basename(src, path.extname(src))}-${stamp}`))));
fs.mkdirSync(outDir, { recursive: true });

function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(exe)} 失败（${r.status}）：${(r.stderr || r.stdout || '').slice(-400)}`);
  return r.stdout;
}

// ffmpeg 在 winget 的包里，PATH 上有；找不到就报清楚
const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', windowsHide: true });
if (probe.status !== 0) { console.error('找不到 ffprobe/ffmpeg，请先确认 PATH（winget 装的 Gyan.FFmpeg）'); process.exit(1); }

const durText = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]).trim();
const duration = Number(durText);
if (!Number.isFinite(duration) || duration <= 0) { console.error(`读不出时长：${durText}`); process.exit(1); }

const frames = [];
let step = every;
if (scene) {
  const threshold = Number(scene);
  const rawDir = path.join(outDir, 'scene');
  fs.mkdirSync(rawDir, { recursive: true });
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `select='gt(scene,${threshold})',scale=${width}:-2`, '-vsync', 'vfr', '-q:v', '3', path.join(rawDir, 'f-%03d.jpg')]);
  const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.jpg')).sort().slice(0, maxFrames);
  files.forEach((f, i) => {
    const dst = path.join(outDir, `frame-${String(i + 1).padStart(3, '0')}.jpg`);
    fs.renameSync(path.join(rawDir, f), dst);
    frames.push({ index: i + 1, timeSec: null, path: dst });
  });
  fs.rmSync(rawDir, { recursive: true, force: true });
} else {
  // 均匀取点；时长太长时自动拉大间隔，保证不超过 max 张
  let step = every;
  if (duration / step > maxFrames) step = duration / maxFrames;
  for (let t = 0, i = 1; t < duration && frames.length < maxFrames; t += step, i++) {
    const dst = path.join(outDir, `frame-${String(i).padStart(3, '0')}.jpg`);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.min(t, duration - 0.1)), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', dst]);
    if (fs.existsSync(dst)) frames.push({ index: i, timeSec: Math.round(Math.min(t, duration) * 10) / 10, path: dst });
  }
}

let audio = null;
if (wantAudio) {
  const wav = path.join(outDir, 'audio-16k.wav');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav]);
  audio = wav;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const manifest = { source: src, durationSec: Math.round(duration), mode: scene ? `scene>${scene}` : `every ${Math.round(step)}s`, width, frames, audio };
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`🎞 ${path.basename(src)}　时长 ${mmss(duration)}　抽了 ${frames.length} 帧（${manifest.mode}）`);
console.log(`目录：${outDir}`);
for (const f of frames) console.log(`${String(f.index).padStart(3, '0')}  ${f.timeSec === null ? '   ?  ' : mmss(f.timeSec).padStart(6)}  ${f.path}`);
if (audio) console.log(`音频：${audio}`);
console.log('下一步：对这些路径逐张 read_image（一次最多几张，别一口气全塞）。');
