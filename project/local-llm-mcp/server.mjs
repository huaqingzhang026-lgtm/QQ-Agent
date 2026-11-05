// 本地小模型的 MCP 外壳：只做「压缩 / 分类 / 改写」，不替她说话。
//
// 设计约束（重要）：
//   · 不接 system prompt、不接对话历史 —— 避免被当成"另一个自己"；
//   · 返回 JSON（要点 + 原文引用），最终的 QQ 回复必须由她本人组织；
//   · 只调本机 llama.cpp（127.0.0.1:11435），不花钱、不联网。
//
// 工具：local_llm_chat(mode: summarize|classify|rewrite, text, max_chars?, tags?)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BASE = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const MODEL = process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b-instruct';
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'local-llm-calls.jsonl');

function logCall(rec) {
  try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); } catch {}
}

async function chat(system, user, { maxTokens = 400, json = true, schema = null } = {}) {
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
    ...(schema
      ? { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } } }
      : json ? { response_format: { type: 'json_object' } } : {}),
  };
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`local model HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  return String(j.choices?.[0]?.message?.content ?? '').trim();
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// 小模型有时把 points 写成对象数组（{text:...}），统一压成字符串，别让调用方看到 [object Object]
const asText = (x) => {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return String(x.text ?? x.point ?? x.content ?? x.value ?? JSON.stringify(x));
  return String(x ?? '');
};

const HANDLERS = {
  async summarize({ text, max_chars = 200 }) {
    const system = '你是文本压缩器。把用户给的文本压成最多 5 条具体要点（每条一句话，说清谁做了什么、结果如何，不要抽象标题），' +
      '并摘 1~3 句原文关键句（一字不改）。不要评价、不要补充原文没有的信息。';
    const schema = {
      type: 'object',
      properties: {
        points: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        quotes: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      },
      required: ['points', 'quotes'],
      additionalProperties: false,
    };
    let out = '';
    try {
      out = await chat(system, String(text).slice(0, 12000), { maxTokens: 500, schema });
    } catch {
      out = await chat(system, String(text).slice(0, 12000), { maxTokens: 500, schema: null, json: false });
    }
    const j = parseJson(out);
    if (!j) {
      // 兜底：当成「每行一条要点」来读，至少还能给出点东西
      const lines = out.split(/\r?\n/).map((l) => l.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean).slice(0, 6);
      return { ok: lines.length > 0, mode: 'summarize', points: lines, quotes: [], raw: lines.length ? undefined : out.slice(0, 400) };
    }
    return {
      ok: true,
      mode: 'summarize',
      points: (j.points ?? []).slice(0, 6).map(asText),
      quotes: (j.quotes ?? []).slice(0, 3).map(asText),
      note: '要点只是压缩，事实以原文为准；回复请用她自己的话。',
    };
  },

  async classify({ text, tags }) {
    const list = Array.isArray(tags) && tags.length ? tags.map(String) : ['闲聊', '求助', '情绪', '广告', '其他'];
    const system = `你是分类器。只输出 JSON：{"label":"...","reason":"..."}。label 必须是给定标签之一：${list.join('、')}。reason 不超过 20 字。`;
    const out = await chat(system, String(text).slice(0, 4000), { maxTokens: 120 });
    const j = parseJson(out);
    if (!j) return { ok: false, mode: 'classify', raw: out.slice(0, 400) };
    const label = list.includes(String(j.label)) ? String(j.label) : '其他';
    return { ok: true, mode: 'classify', label, reason: String(j.reason ?? '').slice(0, 40) };
  },

  async rewrite({ text, max_chars = 80 }) {
    const system = `你是改写器。把用户给的一段话改写成不超过 ${Number(max_chars)} 字的简体中文，保留原意，不添加原文没有的信息，不加引号。只输出改写后的文本。`;
    const out = await chat(system, String(text).slice(0, 6000), { maxTokens: 300, json: false });
    return { ok: true, mode: 'rewrite', text: out.slice(0, Number(max_chars) * 2) };
  },
};

const TOOL = {
  name: 'local_llm_chat',
  description:
    '本地小模型（3B，不花钱、不联网）的压缩/分类/改写工具。**只用来处理长文本或做归类，不要用它生成你要发出去的回复**。' +
    'mode=summarize 把一大段文字压成要点（返回 points + 原文 quotes）；mode=classify 把文本归到给定标签；' +
    'mode=rewrite 把太长的话改短。返回 JSON，最终怎么回话由你自己组织；事实以原文为准，别把摘要里的推断当事实。' +
    '短消息（不到 200 字）不要调用——没有意义。',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['summarize', 'classify', 'rewrite'], description: '要它做什么' },
      text: { type: 'string', description: '待处理的原始文本（长文本可以整段贴）' },
      max_chars: { type: 'number', description: 'rewrite 的目标字数，默认 80' },
      tags: { type: 'array', items: { type: 'string' }, description: 'classify 用的候选标签' },
    },
    required: ['mode', 'text'],
  },
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'local-llm-mcp', version: '0.1.0' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const fn = name === 'local_llm_chat' ? HANDLERS[args.mode] : null;
      if (!fn) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `未知工具/模式：${name}/${args.mode}` }) }], isError: true } });
        return;
      }
      const started = Date.now();
      try {
        const out = await fn(args);
        logCall({ mode: args.mode, chars: String(args.text ?? '').length, ms: Date.now() - started, ok: out.ok !== false });
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
      } catch (e) {
        logCall({ mode: args.mode, chars: String(args.text ?? '').length, ms: Date.now() - started, ok: false, error: String(e?.message ?? e).slice(0, 200) });
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `本地模型调用失败：${e?.message ?? e}（服务没起来？）` }) }], isError: true } });
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
