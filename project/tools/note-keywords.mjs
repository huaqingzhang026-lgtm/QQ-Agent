// 从她的笔记/日记里抽"话题词"，写进 state\topic-keywords.json。
// 桥接的群聊唤醒用它：命中话题词时按 topicProbability 掷骰子（默认 0.2），而不是百分百唤醒。
//
// 默认用本地 3B 抽（语义准）；模型不可用时回退到 n-gram 统计。
// 用法：node tools\note-keywords.mjs [--limit 40] [--heuristic]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(ROOT, 'agent-home');
const OUT = path.join(ROOT, 'qq-bridge', 'state', 'topic-keywords.json');
const LOCAL = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const LIMIT = Number(arg('limit', 40));
const heuristicOnly = process.argv.includes('--heuristic');

const BLOCK = new Set([
  'diary', 'index', 'inbox', 'todo', 'rules', 'readme', 'tools', 'notes', 'node', 'agent-home', 'transcript',
  '主人', '自己的', '自己', '别人', 'deepseek', '今天', '明天', '昨天', '早上', '下午', '晚上', '时间', '内容',
  '东西', '地方', '问题', '一次', '一条', '一句', '一个', '一下', '出来', '发现', '结论', '教程', '为什么',
  '只有', '第一', '两个', '三个', '同一', '个数', '分钟', '数字', '笔记', '工具', '视频', '转写', '事情',
  'md', 'json', 'mjs', 'js', 'txt', 'tmp', 'llm', 'mcp', 'api', 'ai', 'ok', 'id', 'text', 'tips', 'powershell',
]);

const files = [];
(function walk(dir, depth = 0) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.') && !['images', 'frames', 'transcripts', 'daily'].includes(e.name)) walk(p, depth + 1); }
    else if (/\.(md|txt)$/i.test(e.name)) files.push(p);
  }
})(HOME);

const titles = files.map((f) => path.basename(f).replace(/\.(md|txt)$/i, '')).filter((s) => s.length >= 2);
const excerpts = files.map((f) => {
  try {
    const t = fs.readFileSync(f, 'utf8');
    const head = t.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n');
    return `## ${path.basename(f)}\n${head}`;
  } catch { return ''; }
}).join('\n\n').slice(0, 9000);

const clean = (list) => {
  const out = [];
  for (let w of list) {
    w = String(w ?? '').trim().replace(/^[#*\-\s]+/, '');
    if (w.length < 2 || w.length > 14) continue;
    if (BLOCK.has(w.toLowerCase())) continue;
    if (/^[0-9\-. ]+$/.test(w)) continue;
    if (/[.\/\\_（）【】《》、，。：“”"']/.test(w) && !/[A-Za-z]/.test(w)) continue;
    if (out.includes(w)) continue;
    out.push(w);
    if (out.length >= LIMIT) break;
  }
  return out;
};

async function viaLocal() {
  const system = '你是话题抽取器。从下面的笔记标题和摘要里，抽出适合当"话题关键词"的词或短语：具体的对象、作品、人物、产品、技术名词、事件。' +
    '不要抽象词（"今天""时间""东西"）、不要文件名/代码名、不要隐私。每个 2~10 字，输出 JSON：{"keywords":["..."]}，最多 40 个。';
  const res = await fetch(`${LOCAL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify({
      model: process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b-instruct',
      messages: [{ role: 'system', content: system }, { role: 'user', content: `笔记标题：${titles.join('、')}\n\n${excerpts}` }],
      temperature: 0.3,
      max_tokens: 700,
      stream: false,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`local ${res.status}`);
  const j = JSON.parse(await res.text());
  const raw = String(j.choices?.[0]?.message?.content ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  const obj = m ? JSON.parse(m[0]) : null;
  if (!Array.isArray(obj?.keywords)) throw new Error('local 没给 keywords');
  return obj.keywords;
}

function viaHeuristic() {
  const text = files.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const counts = new Map();
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const w = run.slice(i, i + n);
        if (/^[的了是在和就都也很不没有我你他她它们这那个只一条把被对给从向于还有会能要]/.test(w)) continue;
        if (/[的了着过吗呢吧啊]/.test(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].filter(([, c]) => c >= 6).sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

let src = 'heuristic';
let words = [];
if (!heuristicOnly) {
  try { words = await viaLocal(); src = 'local-llm'; }
  catch (e) { console.warn(`本地模型不可用（${e.message}），回退到统计法`); }
}
if (!words.length) { words = viaHeuristic(); src = 'heuristic'; }

const keywords = clean([...titles, ...words]);
fs.writeFileSync(OUT, `${JSON.stringify({ updatedAt: new Date().toISOString(), source: src, files: files.length, keywords }, null, 2)}\n`, 'utf8');
console.log(`[${src}] 从 ${files.length} 篇笔记/日记里抽到 ${keywords.length} 个话题词：`);
console.log(keywords.join('、'));
