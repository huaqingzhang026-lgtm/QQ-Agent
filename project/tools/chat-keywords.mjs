// 从群聊里捕捉"值得去搜"的关键词，写进 state\chat-keywords.json 的 pending 队列。
// 之后由 tools\kb-fetch.mjs 拿这些词去 B站/微博/小红书搜，结果落到 agent-home\kb\。
//
// 用法：node tools\chat-keywords.mjs [--limit 8] [--mark-processed kw1,kw2]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const OUT = path.join(STATE, 'chat-keywords.json');
const LOCAL = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const STOP = new Set(['这个', '那个', '什么', '怎么', '为什么', '不是', '没有', '可以', '就是', '还是', '真的', '有点', '一个', '一下', '今天', '明天', '昨天', '现在', '已经', '然后', '所以', '但是', '如果', '因为', '这些', '那些', '我们', '你们', '他们', '自己', '感觉', '觉得', '知道', '东西', '事情', '问题', '时候', '哈哈', '哈哈哈', '笑死', '真的假的', '好吧', '行吧', '好的', '谢谢', '晚安', '早安']);
const BLOCK = new Set(['主人', 'deepseek', '小鲸鱼', '机器人', 'ai']);

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const state = readJson(OUT, { updatedAt: null, pending: [], processed: [] });

function markProcessed(list) {
  const set = new Set(list.map((x) => String(x).trim()).filter(Boolean));
  if (!set.size) return;
  state.pending = (state.pending ?? []).filter((p) => !set.has(p.kw));
  state.processed = [...new Set([...(state.processed ?? []), ...set])].slice(-300);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(`已标记处理：${[...set].join('、')}（剩余 pending ${state.pending.length}）`);
}

const markArg = arg('mark-processed', null);
if (markArg && markArg !== true) { markProcessed(String(markArg).split(/[,，、\s]+/)); process.exit(0); }

const limit = Number(arg('limit', 6));
const social = readJson(path.join(STATE, 'social-v2.json'), {});
const groupKeys = Object.keys(social.conversations ?? {}).filter((k) => k.startsWith('group:'));
const msgs = [];
for (const k of groupKeys) {
  for (const m of social.conversations[k].recentMessages ?? []) {
    if (m.isSelf) continue;
    const t = String(m.text ?? '').trim();
    if (t.length < 4 || /^\[(图片|表情|语音|动画表情)\]$/.test(t)) continue;
    msgs.push({ k, t, time: Number(m.time) || 0 });
  }
}
if (!msgs.length) { console.log('群聊里没有可用消息'); process.exit(0); }

const inputArg = arg('input', null);
const corpus = inputArg && inputArg !== true
  ? fs.readFileSync(path.resolve(ROOT, String(inputArg)), 'utf8').slice(0, 6000)
  : msgs.slice(-120).map((m) => m.t).join('\n').slice(0, 6000);

async function viaLocal() {
  const system = '你是话题捡拾器。从群聊记录里挑出"值得去 B站/微博/小红书搜一搜"的具体对象：作品名、游戏、剧、主播/UP 主、产品、新闻事件、梗的出处。' +
    '不要抽象词、不要人名隐私、不要"哈哈/笑死/真的"这类语气词、不要整句。每个 2~12 字。输出 JSON：{"keywords":["..."]}，最多 8 个；没值得搜的就给空数组。';
  const res = await fetch(`${LOCAL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify({
      model: process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b-instruct',
      messages: [{ role: 'system', content: system }, { role: 'user', content: corpus }],
      temperature: 0.4, max_tokens: 400, stream: false,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`local ${res.status}`);
  const j = JSON.parse(await res.text());
  const raw = String(j.choices?.[0]?.message?.content ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  const obj = m ? JSON.parse(m[0]) : null;
  return Array.isArray(obj?.keywords) ? obj.keywords : [];
}

let words = [];
let source = 'local-llm';
try { words = await viaLocal(); } catch (e) { console.warn(`本地模型不可用（${e.message}），跳过`); source = 'none'; }

const known = new Set([...(state.pending ?? []).map((p) => p.kw), ...(state.processed ?? [])]);
const fresh = [];
for (let w of words) {
  w = String(w ?? '').trim().replace(/^[#*\-\s]+/, '').replace(/[《》""'']/g, '');
  if (w.length < 2 || w.length > 12) continue;
  if (STOP.has(w) || BLOCK.has(w.toLowerCase())) continue;
  if (known.has(w)) continue;
  if (fresh.includes(w)) continue;
  fresh.push(w);
  if (fresh.length >= limit) break;
}

if (!fresh.length) {
  state.updatedAt = new Date().toISOString();
  state.pending = state.pending ?? [];
  state.processed = state.processed ?? [];
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(`没有新的关键词（模型给出 ${words.length} 个，全被过滤/去重）`);
  process.exit(0);
}

const now = new Date().toISOString();
for (const kw of fresh) {
  const hit = msgs.filter((m) => m.t.includes(kw)).slice(-2);
  (state.pending ??= []).push({ kw, source, at: now, groups: [...new Set(hit.map((m) => m.k))], context: hit.map((m) => m.t.slice(0, 60)) });
}
state.updatedAt = now;
fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
console.log(`新增 ${fresh.length} 个待搜关键词：${fresh.join('、')}（pending 共 ${state.pending.length}）`);
