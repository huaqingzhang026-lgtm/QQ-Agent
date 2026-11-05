// 让她用自己的「声音」说话：文字 → mp3（Edge TTS，免费、不要 key）。
//
// 产物默认直接落进 qq-bridge\audio\（也就是语音库），所以生成完就能用
// qq_send_voice 当语音条发出去。
//
// 用法：
//   node tools\say.mjs --text "在呢" --voice Xiaoxiao
//   node tools\say.mjs --text "..." --voice Xiaoyi --rate +10% --pitch +20Hz
//   node tools\say.mjs --list                     # 看可选音色
//
// 音色短名 → 全名：
//   Xiaoxiao 温柔女声 / Xiaoyi 少女 / Yunxi 青年男声 / Yunjian 播音男 / Yunxia 少年 / Xiaobei 东北话 / Xiaoni 陕西话
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const AUDIO_DIR = path.join(ROOT, 'qq-bridge', 'audio');

const VOICES = {
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',
  xiaoyi: 'zh-CN-XiaoyiNeural',
  yunxi: 'zh-CN-YunxiNeural',
  yunjian: 'zh-CN-YunjianNeural',
  yunxia: 'zh-CN-YunxiaNeural',
  yunyang: 'zh-CN-YunyangNeural',
  xiaobei: 'zh-CN-liaoning-XiaobeiNeural',
  xiaoni: 'zh-CN-shaanxi-XiaoniNeural',
};

// 情绪预设：只调 rate/pitch/volume 三个旋钮（edge-tts 支持的就是这些）
const MOODS = {
  '正常': { rate: '+0%', pitch: '+0Hz', volume: '+0%' },
  '撒娇': { rate: '+6%', pitch: '+30Hz', volume: '+0%' },
  '开心': { rate: '+10%', pitch: '+20Hz', volume: '+5%' },
  '生气': { rate: '+12%', pitch: '+8Hz', volume: '+15%' },
  '难过': { rate: '-15%', pitch: '-12Hz', volume: '-10%' },
  '困': { rate: '-22%', pitch: '-18Hz', volume: '-15%' },
  '小声': { rate: '-8%', pitch: '-5Hz', volume: '-30%' },
  '播音': { rate: '-6%', pitch: '-8Hz', volume: '+0%' },
};

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

if (process.argv.includes('--list')) {
  console.log('可选音色（短名 → 全名）：');
  for (const [k, v] of Object.entries(VOICES)) console.log(`  ${k.padEnd(9)} ${v}`);
  console.log('\n可选情绪（--mood，会被显式 --rate/--pitch/--volume 覆盖）：');
  for (const [k, v] of Object.entries(MOODS)) console.log(`  ${k.padEnd(6)} rate ${v.rate}  pitch ${v.pitch}  volume ${v.volume}`);
  process.exit(0);
}

const text = arg('text');
if (!text || text === true) { console.error('用法：node tools\\say.mjs --text "要说的话" [--voice xiaoyi] [--mood 撒娇|生气|困|开心|难过|小声] [--rate +0%] [--pitch +0Hz] [--volume +0%] [--out 路径]'); process.exit(1); }

const voiceArg = String(arg('voice', 'xiaoxiao'));
const full = VOICES[voiceArg.toLowerCase()] ?? (String(voiceArg).includes('Neural') ? String(voiceArg) : null);
if (!full) { console.error(`未知音色：${voiceArg}（用 --list 看可选项）`); process.exit(1); }

const moodArg = arg('mood', null);
const mood = moodArg && moodArg !== true ? MOODS[String(moodArg)] : null;
if (moodArg && moodArg !== true && !mood) { console.error(`未知情绪：${moodArg}（可选：${Object.keys(MOODS).join(' / ')}）`); process.exit(1); }

const rate = String(arg('rate', mood?.rate ?? '+0%'));
const pitch = String(arg('pitch', mood?.pitch ?? '+0Hz'));
const volume = String(arg('volume', mood?.volume ?? '+0%'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = String(text).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 12) || 'say';
const out = path.resolve(ROOT, String(arg('out', path.join('qq-bridge', 'audio', `${stamp}-${slug}.mp3`))));
fs.mkdirSync(path.dirname(out), { recursive: true });

// 注意用 --opt=value 形式：负值（如 -22%）直接跟在空格后面会被 argparse 当成选项
const r = spawnSync('python', ['-m', 'edge_tts', '--voice', full, '--text', String(text), `--rate=${rate}`, `--pitch=${pitch}`, `--volume=${volume}`, '--write-media', out], { encoding: 'utf8', windowsHide: true });
if (r.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1024) {
  console.error(`生成失败（${r.status}）：${(r.stderr || r.stdout || '').slice(-400)}`);
  process.exit(1);
}

const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8', windowsHide: true });
const seconds = Number(String(dur.stdout).trim());
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`🔊 ${path.basename(out)}　${Number.isFinite(seconds) ? seconds.toFixed(1) + 's' : '?'}　${kb} KB　音色 ${full}`);
console.log(out);
console.log('发出去：qq_send_voice(file=上面这个文件名)');
