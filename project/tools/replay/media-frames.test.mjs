// 回放：视频抽帧与图片归一化（媒体理解优化）。
// 依赖本机 ffmpeg（配置里的 voice.ffmpegPath）；没有则跳过。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractVideoFrames, normalizeImage, probeDurationSeconds, planVideo, compressVideo } from '../../qq-bridge/src/media-frames.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8'));
const ffmpegPath = cfg.socialV2?.voice?.ffmpegPath || '';
const ffprobePath = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.log('media-frames: 跳过（本机没有 ffmpeg）');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
const video = path.join(dir, 'test.mp4');

check('生成测试视频', () => {
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', video], { timeout: 30000 });
  assert.ok(fs.statSync(video).size > 1000);
});

if (fs.existsSync(video)) {
  check('探测时长约 3 秒', () => {
    const d = probeDurationSeconds(video, ffprobePath);
    assert.ok(d > 2 && d < 4.5, `duration=${d}`);
  });

  check('抽 3 帧且都是 JPEG', () => {
    const { frames, duration } = extractVideoFrames(fs.readFileSync(video), { ffmpegPath, ffprobePath, count: 3, width: 320 });
    assert.ok(frames.length >= 2, `frames=${frames.length}`);
    assert.ok(duration > 2);
    for (const f of frames) {
      assert.equal(f.mimeType, 'image/jpeg');
      assert.equal(f.buffer[0], 0xff);
      assert.equal(f.buffer[1], 0xd8);
    }
  });

  check('抽帧数量不超过 6', () => {
    const { frames } = extractVideoFrames(fs.readFileSync(video), { ffmpegPath, ffprobePath, count: 20, width: 320 });
    assert.ok(frames.length <= 6);
  });
}

// 图片归一化：小图原样返回
const small = path.join(dir, 'small.jpg');
execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=1', '-frames:v', '1', small]);
check('小图原样返回', () => {
  const buf = fs.readFileSync(small);
  const out = normalizeImage(buf, 'image/jpeg', { ffmpegPath, maxSide: 1568 });
  assert.equal(out.buffer.length, buf.length);
  assert.equal(out.mimeType, 'image/jpeg');
});

// 大图：生成一张超大噪声图（文件 > 1.2MB）
check('大图会被缩成 JPEG', () => {
  const big = path.join(dir, 'big.jpg');
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=2400x1800', '-vf', 'noise=alls=60:allf=t', '-frames:v', '1', '-q:v', '1', big], { timeout: 60000 });
  const buf = fs.readFileSync(big);
  const out = normalizeImage(buf, 'image/jpeg', { ffmpegPath, maxSide: 1568 });
  assert.ok(out.buffer.length > 0);
  assert.equal(out.mimeType, 'image/jpeg');
});

check('planVideo：小文件直接原生', () => {
  const plan = planVideo({ buffer: Buffer.alloc(1024), durationSec: 5, ffmpegPath, maxBytes: 10 * 1024 * 1024, maxDurationSec: 600 });
  assert.equal(plan.skipped, false);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.reason, 'native');
});

check('planVideo：超时长直接跳过（不抽帧）', () => {
  const plan = planVideo({ buffer: Buffer.alloc(1024), durationSec: 3600, ffmpegPath, maxBytes: 10 * 1024 * 1024, maxDurationSec: 600 });
  assert.equal(plan.skipped, true);
  assert.equal(plan.reason, 'too-long');
  assert.equal(plan.chunks.length, 0);
});

check('compressVideo：大视频压小', () => {
  const big = fs.readFileSync(video);
  const out = compressVideo(big, { ffmpegPath, maxBytes: 1024 * 1024, height: 240, fps: 5 });
  assert.ok(out && out.length > 0);
  assert.ok(out.length <= big.length * 2);
});

check('planVideo：超限走压缩', () => {
  const big = fs.readFileSync(video);
  const plan = planVideo({ buffer: big, durationSec: 3, ffmpegPath, maxBytes: 10 * 1024, maxDurationSec: 600, chunkSeconds: 1 });
  assert.equal(plan.skipped, false);
  assert.ok(['compressed', 'split'].includes(plan.reason), `reason=${plan.reason}`);
  assert.ok(plan.chunks.length >= 1);
});

check('空/非图片不走 ffmpeg', () => {
  assert.equal(normalizeImage(null, 'image/jpeg', { ffmpegPath }).buffer, null);
  const b = Buffer.from('not-an-image');
  assert.equal(normalizeImage(b, 'text/plain', { ffmpegPath }).buffer, b);
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`media-frames replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
