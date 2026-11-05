// 夜间话题候选：用本地 3B 把当天聊天里"值得持续关注"的东西抽出来，供她第二天决定要不要订阅。
//
// 只产出候选，不自动加订阅——加不加由她自己判断（she 的 subscribe_add 一天最多 5 条）。
//
// 用法：node tools\topic-candidates.mjs [--date 2026-10-22] [--no-local]
// 输出：agent-home\notes\subscriptions\candidates-<日期>.md + qq-bridge\state\subscription-candidates.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const NOTES = path.join(ROOT, 'agent-home', 'notes', 'subscriptions');
const LOG = path.join(ROOT, 'tools', 'topics.log');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const now = new Date();
const localDay = (d = now) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = String(arg('date', localDay()));
const start = new Date(`${day}T00:00:00`).getTime();
const end = start + 86400000;

const log = (m) => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };

// ── 收集当天聊天（或 --input 指定的文本，便于测试）────────────────────────────
const social = readJson(path.join(STATE, 'social-v2.json'), {});
const msgs = [];
for (const [key, conv] of Object.entries(social.conversations ?? {})) {
  for (const m of conv.recentMessages ?? []) {
    const t = Number(m.time) || 0;
    if (t < start || t >= end) continue;
    const text = String(m.text ?? m.plain ?? '').trim();
    if (text.length < 5) continue;              // 略过"行""ok""嘻嘻"这类
    if (/^\[(图片|表情|语音|动画表情)\]$/.test(text)) continue;
    msgs.push({ key, who: m.isSelf ? '我' : '对方', text });
  }
}
if (!msgs.length) { log(`${day} 没有聊天记录，跳过`); process.exit(0); }

const inputFile = arg('input', null);
const transcript = inputFile && inputFile !== true
  ? fs.readFileSync(path.resolve(ROOT, String(inputFile)), 'utf8').slice(0, 8000)
  : msgs.slice(-120).map((m) => `${m.who}说：${m.text}`).join('\n').slice(0, 8000);

// ── 本地模型抽取 ────────────────────────────────────────────────────────────
const BASE = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const schema = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['话题', 'UP主', '博主', '关键词'] },
          name: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['kind', 'name', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

const system = '你是话题抽取器。从聊天记录里找出"值得持续关注"的对象：反复出现的兴趣点、某个 UP 主/博主、一部剧/游戏、一个新闻话题、一个产品。' +
  '**不要提取对话参与者本身**（"我""她""对方""主人"这种一律不算），也不要抽隐私（真名、住址、工作单位、感情细节），不要泛泛的"生活""工作"。' +
  'name 要具体、能直接当搜索关键词（例如"《光与影》""影视飓风""宇树机器人"）。why 一句话，20 字内。最多 6 条；' +
  '如果这段聊天里确实没有值得长期关注的东西，就返回空数组，不要硬凑。';

let topics = [];
let modelError = null;
let skipped = false;
if (process.argv.includes('--no-local')) {
  skipped = true;
  log('--no-local：跳过模型，只记录聊天');
} else {
  // 2026-10-27 改：3B 模型吃不下长文本。
  // 实测同一段聊天：喂 8000 字 → 0 个候选；3000 字 → 0；**1200 字 → 4 个**。
  // 之前把 120 条压进 8000 字符喂一次，所以经常"抽不到"。
  // 现在改成：按消息边界切段（每段 ≤1200 字），逐段抽，再合并去重。
  const CHUNK = 1200;
  const chunks = [];
  {
    let cur = '';
    for (const line of transcript.split('\n')) {
      if (cur.length + line.length + 1 > CHUNK && cur) {
        chunks.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) chunks.push(cur);
  }
  log(`分 ${chunks.length} 段抽取（每段 ≤${CHUNK} 字，总 ${transcript.length} 字）`);

  const seen = new Set();
  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
        body: JSON.stringify({
          model: process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b-instruct',
          messages: [{ role: 'system', content: system }, { role: 'user', content: chunks[i] }],
          temperature: 0.2,
          max_tokens: 500,
          stream: false,
          response_format: { type: 'json_schema', json_schema: { name: 'topics', strict: true, schema } },
        }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(text);
      const content = String(body.choices?.[0]?.message?.content ?? '{}');
      const j = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      for (const t of j.topics ?? []) {
        const name = String(t?.name ?? '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        topics.push({ kind: t.kind, name, why: t.why });
      }
    } catch (e) {
      modelError = e.message;
      log(`  第 ${i + 1}/${chunks.length} 段抽取失败：${e.message}`);
    }
  }
  topics = topics.slice(0, 6);
}

// ── 落盘 ────────────────────────────────────────────────────────────────────
fs.mkdirSync(NOTES, { recursive: true });
const file = path.join(NOTES, `candidates-${day}.md`);
// 2026-10-27 修：原来三种情况共用一句"（今天没抽出什么，或模型不可用）"——
// 分不清"模型挂了"和"模型正常但没抽到"，等于把两种情况压成一个。现在分开写。
const lines = topics.length
  ? topics.map((t) => `- **${t.name}**（${t.kind}）：${t.why}`)
  : skipped
    ? ['（跳过了模型抽取：这次用了 --no-local）']
    : modelError
      ? [`（模型调用失败：${modelError}）`]
      : ['（模型正常返回，但没有抽到值得长期关注的主题——不是出错）'];
const srcLabel = inputFile && inputFile !== true ? `--input ${String(inputFile)}` : `当天聊天（${msgs.length} 条）`;
fs.writeFileSync(file, `# ${day} 订阅候选\n\n来源：${srcLabel}\n\n${lines.join('\n')}\n\n> 这些只是候选。值得追的用 \`subscribe_add\` 加，一天最多 5 条。\n`, 'utf8');

const pool = path.join(STATE, 'subscription-candidates.json');
fs.writeFileSync(pool, `${JSON.stringify({ date: day, generatedAt: new Date().toISOString(), count: msgs.length, topics }, null, 2)}\n`, 'utf8');

log(`${day}：${msgs.length} 条聊天 → ${topics.length} 个候选${topics.length ? '：' + topics.map((t) => t.name).join('、') : ''}`);
log(`写入 ${path.relative(ROOT, file)}`);
