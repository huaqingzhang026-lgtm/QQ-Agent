// 人格单一源构建（S6.1）：persona.prompt.txt + agent.cordis.tpl.yml → agent.cordis.yml
//
// 背景：人格正文一直直接写在 YAML 的 `prefix: >-` 块里，改一行要同时动 YAML 缩进，
// 且没法判断"生成的 patch 和源是否一致"。现在把唯一可编辑的正文抽到
// `persona.prompt.txt`，YAML 由模板渲染，生成物不要手改。
//
// 用法：
//   node tools/persona-build.mjs           # 生成 agent.cordis.yml
//   node tools/persona-build.mjs --check   # 只校验是否与源一致（CI/启动前）
//
// 注意：为了不让第一次迁移改变线上 prompt，渲染结果与原文件**逐字节一致**（已验证），
// 因此这里不往 YAML 里加注释头；版本信息写在 persona.generated.json。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2');
const TPL = path.join(DIR, 'agent.cordis.tpl.yml');
const PROMPT = path.join(DIR, 'persona.prompt.txt');
const OUT = path.join(DIR, 'agent.cordis.yml');
const META = path.join(DIR, 'persona.generated.json');

const INDENT = '      '; // 6 空格，与现有人格块一致

export function renderPersona(tpl, prompt) {
  const template = String(tpl);
  const raw = String(prompt ?? '');
  // 保留每一行自己的换行符（历史文件是 CRLF/LF 混合的），只补缩进。
  const body = raw
    .split(/(?<=\n)/)
    .map((seg) => {
      const m = /^(.*?)(\r?\n)?$/.exec(seg);
      const text = m?.[1] ?? '';
      const eol = m?.[2] ?? '';
      if (!text.trim()) return eol;
      return INDENT + text + eol;
    })
    .join('')
    .replace(/(?:\r?\n)+$/, '');
  return template.replace('{{PERSONA_PROMPT_BLOCK}}', body);
}

function hash(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function main() {
  const tpl = fs.readFileSync(TPL, 'utf8');
  const prompt = fs.readFileSync(PROMPT, 'utf8');
  const rendered = renderPersona(tpl, prompt);
  const check = process.argv.includes('--check');
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

  if (check) {
    if (current === rendered) {
      console.log(`人格源与生成物一致（${hash(rendered).slice(0, 12)}）`);
      process.exit(0);
    }
    console.error('人格生成物与源不一致：先运行 node tools/persona-build.mjs');
    process.exit(1);
  }

  fs.writeFileSync(OUT, rendered, 'utf8');
  const meta = {
    version: hash(rendered).slice(0, 12),
    renderedHash: hash(rendered),
    promptHash: hash(prompt),
    tplHash: hash(tpl),
    promptLines: prompt.split('\n').length,
    outLines: rendered.split('\n').length,
    generatedAt: new Date().toISOString(),
    note: '生成物：改 persona.prompt.txt 后运行 tools/persona-build.mjs，不要手改 agent.cordis.yml',
  };
  fs.writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`已生成 ${path.relative(ROOT, OUT)}（版本 ${meta.version}，${meta.outLines} 行）`);
}

const isMain = (() => {
  try { return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url; }
  catch { return false; }
})();
if (isMain) main();
