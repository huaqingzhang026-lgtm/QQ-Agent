// 本地小模型：便宜活的跑腿工（OpenAI 兼容接口，Ollama / llama.cpp 都能接）。
//
// 定位：不打工具、不查网、不做复杂推理。适合分类、打标签、摘要、改写、翻译、
// 把一堆弹幕归纳成几句话这种「量大、要求不高」的活。需要动工具/查资料的活走 DSH 会话。
//
// 用法：
//   node tools\local-llm.mjs --prompt "把这句话改短：今天天气不错我们出去走走吧"
//   node tools\local-llm.mjs --file 弹幕.txt --system "你是弹幕归纳器" --json
//   node tools\local-llm.mjs --list
//
// 环境变量：
//   LOCAL_LLM_BASE  默认 http://127.0.0.1:11434/v1 （Ollama）；llama.cpp 用 http://127.0.0.1:11435/v1
//   LOCAL_LLM_MODEL 默认 qwen2.5:3b-instruct
//   LOCAL_LLM_KEY   API key（Ollama 随便填，llama.cpp 可空）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const KEY = process.env.LOCAL_LLM_KEY || 'local';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function http(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Number(arg('timeout', 600000))),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

if (process.argv.includes('--list')) {
  try {
    const j = await http('/models');
    const names = (j.data ?? []).map((m) => m.id);
    console.log(names.length ? names.join('\n') : '（服务在跑，但没看到模型）');
  } catch (e) {
    console.error(`本地模型服务没起来（${BASE}）：${e.message}`);
    console.error('检查：ollama serve / 计划任务 HerLocalLLM');
    process.exit(1);
  }
  process.exit(0);
}

const fileArg = arg('file');
const prompt = fileArg && fileArg !== true
  ? fs.readFileSync(path.resolve(ROOT, String(fileArg)), 'utf8')
  : String(arg('prompt', ''));
if (!prompt) { console.error('用法：node tools\\local-llm.mjs --prompt "..." 或 --file 文本文件 [--system "..."] [--json] [--model qwen2.5:3b-instruct]'); process.exit(1); }

const model = String(arg('model', process.env.LOCAL_LLM_MODEL || 'qwen2.5:3b-instruct'));
const system = arg('system', '');
const wantJson = process.argv.includes('--json');
const messages = [];
if (system) messages.push({ role: 'system', content: String(system) });
messages.push({ role: 'user', content: prompt });

const started = Date.now();
let j;
try {
  j = await http('/chat/completions', {
    model,
    messages,
    ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
    temperature: Number(arg('temp', 0.3)),
    max_tokens: Number(arg('max', 800)),
    stream: false,
  });
} catch (e) {
  console.error(`调用本地模型失败：${e.message}`);
  console.error(`检查服务：${BASE.replace(/\/v1$/, '')}（计划任务 HerLocalLLM / ollama serve）`);
  process.exit(1);
}

const text = String(j.choices?.[0]?.message?.content ?? '').trim();
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.error(`[local-llm] ${j.model ?? model} · ${secs}s · in ${j.usage?.prompt_tokens ?? '?'} tok · out ${j.usage?.completion_tokens ?? '?'} tok`);
console.log(text);
