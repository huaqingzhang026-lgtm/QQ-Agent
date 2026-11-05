// 把"群友挑出的发言问题"汇总成每天一份的复盘日志。
//
// 触发条件（任一）：
//   · 消息引用了她（quoteTargetIsSelf / 引用文本里有她的昵称）
//   · 消息里出现"AI 味/像 AI/机器人/太正经/客服腔/模板/复读/不像人/太完美"等词
//   · 消息里提到"辨识/识别/检测" + "ai"
// 产物：
//   agent-home\notes\feedback\<日期>.md   （给她的复盘材料，会被 memory_search 索引）
//   同时也追加到 agent-home\notes\daily\<日期>.md（如果有当天的日报）
//
// 用法：node tools\ai-feedback.mjs [--date 2026-10-22] [--no-local]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(ROOT, 'agent-home');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const LOCAL = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const now = new Date();
const localDay = (d = now) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = String(arg('date', localDay()));
const start = new Date(`${day}T00:00:00`).getTime();
const end = start + 86400000;
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };

const CRIT = /(ai\s*味|像\s*ai|是\s*ai|机器人|太正经|正经了|客服腔|客服|模板|复读|不像人|太完美|太流畅|没有情绪|书面语|标点|感叹号|太工整|一眼假|装|演|生成|辨识|识别|检测|抓)/i;

const social = readJson(path.join(STATE, 'social-v2.json'), {});
const groupKeys = Object.keys(social.conversations ?? {}).filter((k) => k.startsWith('group:'));
const hits = [];
const selfTexts = [];

for (const key of groupKeys) {
  const msgs = (social.conversations[key].recentMessages ?? []).slice();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const t = String(m.text ?? '').trim();
    const time = Number(m.time) || 0;
    if (time < start || time >= end) continue;
    if (m.isSelf) { selfTexts.push({ key, t, time, messageId: m.messageId }); continue; }
    if (!t) continue;
    const quotedHer = m.quoteTargetIsSelf === true || /引用\s*Pluto|引用\s*pluto/.test(t);
    if (!quotedHer && !CRIT.test(t)) continue;
    const prev = msgs[i - 1];
    const quoted = /\[引用\s*Pluto\.?[：:]\s*([^\]]+)\]/.exec(t)?.[1]?.trim() ?? '';
    hits.push({ key, time, text: t, quotedHer, quoted, prev: prev && !prev.isSelf ? String(prev.text ?? '').slice(0, 80) : '' });
  }
}

if (!hits.length) {
  console.log(`${day} 没有挑刺类消息，跳过`);
  process.exit(0);
}

// 找出被引用的她那几条原话（粗略：取当天她发过的、时间最接近的）
const nearSelf = (time) => selfTexts.filter((s) => s.time <= time).sort((a, b) => b.time - a.time)[0]?.t?.slice(0, 60) ?? '';

const lines = hits.slice(-40).map((h) => {
  const t = new Date(h.time).toLocaleTimeString('zh-CN', { hour12: false });
  const q = h.quoted || (h.quotedHer ? nearSelf(h.time) : '');
  return `[${t}] 群友：${h.text.replace(/\s+/g, ' ').slice(0, 160)}${q ? `　（她原话：${q.slice(0, 80)}）` : ''}`;
});

let summary = [];
if (!process.argv.includes('--no-local') && lines.length >= 5) {
  try {
    const system = '你是复盘助手。下面是一天里群友对她（一个 QQ 聊天角色）发言的吐槽/挑刺。' +
      '请归纳她发言里的问题，能归纳几条写几条（0~6 条），没有就返回空数组；每条一句话，具体（比如"用词太书面""爱用感叹号""回答太长""总想总结""不懂装懂"），' +
      '并给出改法（一句话）。输出 JSON：{"problems":[{"issue":"...","fix":"...","quote":"群友原话摘录"}]}。只依据材料，不要编。';
    const res = await fetch(`${LOCAL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b-instruct',
        messages: [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n').slice(0, 6000) }],
        temperature: 0.3, max_tokens: 700, stream: false, response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (res.ok) {
      const j = JSON.parse(await res.text());
      const raw = String(j.choices?.[0]?.message?.content ?? '');
      const mm = raw.match(/\{[\s\S]*\}/);
      const obj = mm ? JSON.parse(mm[0]) : null;
      if (Array.isArray(obj?.problems)) {
        const material = lines.join('\n');
        summary = obj.problems.filter((p) => {
          const q = String(p?.quote ?? '').trim();
          return q.length >= 4 && material.includes(q);
        }).slice(0, 6);
      }
    }
  } catch (e) { console.warn(`本地模型不可用（${e.message}），只记原始摘录`); }
}

const md = [
  `# ${day} 群友挑出的问题`,
  '',
  summary.length
    ? summary.map((p, i) => `${i + 1}. **${p.issue}**\n   - 改法：${p.fix ?? '—'}\n   - 原话：${String(p.quote ?? '').slice(0, 100)}`).join('\n')
    : (lines.length < 5
        ? `（素材太少：只有 ${lines.length} 条摘录，少于 5 条，不做归纳，见下）`
        : '（归纳没有产出可用条目——可能是模型不可用，或输出里的引用没能对上材料，见下）'),
  '',
  '## 原始摘录',
  ...lines.map((l) => `- ${l}`),
  '',
].join('\n');

const dir = path.join(HOME, 'notes', 'feedback');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${day}.md`);
fs.writeFileSync(file, md, 'utf8');
console.log(`写入 ${path.relative(ROOT, file)}（${hits.length} 条挑刺，归纳 ${summary.length} 条问题）`);

// 追加到当天日报
const daily = path.join(HOME, 'notes', 'daily', `${day}.md`);
if (fs.existsSync(daily)) {
  let body = fs.readFileSync(daily, 'utf8');
  // 先删掉旧的同名小节，避免重复跑时叠加
  body = body.replace(/\n## 群友挑出的问题\n[\s\S]*?(?=\n## |$)/g, '\n');
  const section = `\n## 群友挑出的问题\n${summary.length ? summary.map((p) => `- ${p.issue}（改法：${p.fix ?? '—'}）`).join('\n') : '- 见 notes/feedback/' + day + '.md'}\n`;
  fs.writeFileSync(daily, body.trimEnd() + '\n' + section, 'utf8');
  console.log('已更新当天日报的小节');
}
