// 人格版本（S6.1/S6.2）：给当前人格生成稳定指纹，写入 state/persona.json。
//
// 目的：人格改动后能回答"线上跑的是哪一版"，会话轮换时也能在日志里对上。
// 单一来源仍是 qq-chat-v2/agent.cordis.yml + 生成的 patch，本脚本只读不写人格。

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const PATCH = path.join(ROOT, 'dsh-home', 'profiles', 'web', 'cordis.patch.yml');
const OUT = path.join(ROOT, 'qq-bridge', 'state', 'persona.json');

export function hashPersona(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function readOr(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}


const isMainModule = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && pathToFileURL(entry).href === import.meta.url;
  } catch { return false; }
})();

function main() {
  const source = readOr(SRC);
  const patch = readOr(PATCH);
  const hash = hashPersona(`${source}\n---\n${patch}`);
  const version = hash.slice(0, 12);
  const blocks = (source.match(/^\s*【[^】]+】/gm) ?? []).length;
  const lines = source.split('\n').length;

  const out = {
    version,
    hash,
    blocks,
    lines,
    source: path.relative(ROOT, SRC),
    patch: path.relative(ROOT, PATCH),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else console.log(`人格版本 ${version}（${blocks} 个区块，${lines} 行）→ ${path.relative(ROOT, OUT)}`);

}

if (isMainModule) main();
