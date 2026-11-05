// 把视频/音频里的**说话**转成文字（本地 faster-whisper，CPU）。
//
// 为什么需要它：她只能读字。字幕/弹幕是 B 站的，别处没有；有了这个，
// 「听懂一个视频」这条链就完整了：抽帧看图 + 转写听声。
//
// 用法：
//   node tools\transcribe.mjs --input "D:\dl\xxx.mp4"
//   node tools\transcribe.mjs --input xxx.mp4 --model small --lang zh
//   node tools\transcribe.mjs --input audio.wav --model base
//
// 模型：tiny / base / small / medium（默认 base≈145MB；small≈470MB，中文明显更准）
// 首次运行会从 hf-mirror.com 下载模型到用户缓存，之后离线可用。
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
  console.error('用法：node tools\\transcribe.mjs --input <视频或音频> [--model base|small] [--lang zh]');
  process.exit(1);
}
const src = path.resolve(ROOT, String(input));
if (!fs.existsSync(src)) { console.error(`找不到文件：${src}`); process.exit(1); }

const model = String(arg('model', 'small'));
const lang = String(arg('lang', 'zh'));
const device = String(arg('device', 'auto'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = path.join('agent-home', 'notes', 'transcripts', `${path.basename(src, path.extname(src))}-${stamp}`);
const outDir = path.resolve(ROOT, String(arg('out', base)));
fs.mkdirSync(outDir, { recursive: true });

// 统一先转 16k 单声道 wav（手机录的 m4a、视频 mp4 都吃）
const wav = path.join(outDir, 'audio-16k.wav');
const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav], { encoding: 'utf8', windowsHide: true });
if (ff.status !== 0 || !fs.existsSync(wav)) { console.error(`抽音轨失败：${(ff.stderr || '').slice(-300)}`); process.exit(1); }

const started = Date.now();
const r = spawnSync('python', [path.join(ROOT, 'tools', 'whisper_transcribe.py'), '--input', wav, '--out', outDir, '--model', model, '--lang', lang, '--device', device], {
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' },
  maxBuffer: 64 * 1024 * 1024,
});
if (r.stdout) process.stdout.write(r.stdout);
const backendLine = String(r.stderr || '').split(/\r?\n/).find((l) => l.startsWith('[model]'));
const warnLine = String(r.stderr || '').split(/\r?\n/).find((l) => l.startsWith('[warn]'));
if (backendLine) console.log(backendLine);
if (warnLine) console.log(warnLine);
if (r.status !== 0) {
  console.error(`转写失败（${r.status}）：${(r.stderr || '').slice(-600)}`);
  process.exit(1);
}

const txtFile = path.join(outDir, 'transcript.txt');
const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8').trim() : '';
const secs = Math.round((Date.now() - started) / 1000);
console.log('────────────────────────────────');
console.log(`✅ 转写完成（${model}，${secs}s）　文字 ${text.length} 字`);
console.log(`文本：${txtFile}`);
console.log(`字幕：${path.join(outDir, 'transcript.srt')}`);
console.log(text.slice(0, 600));
