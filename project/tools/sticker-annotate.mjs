// 给表情库补标注（用 MiMo 视觉模型）。
//
// 用法：
//   node tools/sticker-annotate.mjs --limit 20        # 只处理没有备注的前 20 个
//   node tools/sticker-annotate.mjs --all             # 全部重新标注
//   node tools/sticker-annotate.mjs --dry-run         # 只测，不写回
//
// 只读 stickers.json、只写回 stickers.json；不发送任何 QQ 消息。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../qq-bridge/src/safe-fetch.js';
import { annotateSticker } from '../qq-bridge/src/sticker-annotate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STICKER_FILE = path.join(ROOT, 'qq-bridge', 'state', 'stickers.json');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8'));

const args = process.argv.slice(2);
const all = args.includes('--all');
const dry = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Math.max(1, Number(args[limitArg + 1]) || 20) : (all ? 999 : 20);

if (cfg.socialV2?.vision?.enabled !== true) {
  console.error('vision 未启用（config.socialV2.vision.enabled）');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8'));
const targets = entries.filter((e) => e && e.url && (all || !e.localNote)).slice(0, limit);

console.log(`待标注：${targets.length} / 共 ${entries.length}`);

let ok = 0;
const fails = [];
const notes = new Map();
for (const e of targets) {
  try {
    const { buffer } = await safeFetchBuffer(e.url, 8 * 1024 * 1024);
    const ann = await annotateSticker({ buffer, mimeType: 'image/png', cfg });
    if (!ann) { fails.push(`${e.id}: 解析失败`); continue; }
    notes.set(e.id, ann);
    ok += 1;
    console.log(`✓ ${e.id.slice(-12)} | ${ann.desc} | ${ann.note} | ${ann.tags.join(',')}`);
  } catch (err) {
    fails.push(`${e.id}: ${err?.message ?? err}`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

if (!dry) {
  for (const e of entries) {
    const ann = notes.get(e.id);
    if (!ann) continue;
    e.desc = ann.desc || e.desc;
    e.localNote = ann.note || e.localNote;
    e.tags = ann.tags?.length ? ann.tags : e.tags;
    e.usage = ann.usage || e.usage;
    e.updatedAt = new Date().toISOString();
  }
  fs.writeFileSync(STICKER_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${notes.size} 条标注${dry ? '（dry-run）' : ''}`);
} else {
  console.log(`dry-run：成功 ${notes.size} 条，未写回`);
}

console.log(`完成：成功 ${ok}，失败 ${fails.length}`);
if (fails.length) for (const f of fails.slice(0, 10)) console.log('  ✗', f);
