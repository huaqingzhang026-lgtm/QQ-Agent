// 每日学习：从当天刷到的 B 站视频（标题/简介/标签/热评/字幕）里，
// 评估有没有“值得形成技能”的内容；没有就什么都不写。
//
// 不做最低数量要求：值得才学，不值得就跳过。
//
// 用法：node tools\learn-daily.mjs [--date YYYY-MM-DD] [--now] [--limit 5]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const NOTES = path.join(ROOT, 'agent-home', 'notes');
const SKILLS = path.join(ROOT, 'agent-home', 'skills');
const LOG = path.join(STATE, 'learn-daily.log');
const STATE_FILE = path.join(STATE, 'learn-state.json');
const PID_FILE = path.join(STATE, 'learn-daily.pid');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i < 0) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const cookie = (() => { const c = readJson(path.join(ROOT, 'bili-mcp', 'cookie.json'), {}); return c.sessdata ? `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; DedeUserID=${c.dede_user_id ?? ''}` : ''; })();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

async function bili(url, referer = 'https://www.bilibili.com') {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(20000) });
  return r.json();
}

async function materialFor(bvid, title) {
  const v = await bili(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const d = v?.data;
  if (!d) return null;
  let comments = [];
  try {
    const rep = await bili(`https://api.bilibili.com/x/v2/reply?type=1&oid=${d.aid}&sort=2&ps=10&pn=1`, `https://www.bilibili.com/video/${bvid}`);
    comments = (rep?.data?.replies ?? []).map((r) => String(r?.content?.message ?? '').trim()).filter(Boolean).slice(0, 10);
  } catch {}
  let subtitle = '';
  try {
    const p = await bili(`https://api.bilibili.com/x/player/v2?aid=${d.aid}&cid=${d.cid}`, `https://www.bilibili.com/video/${bvid}`);
    const sub = p?.data?.subtitle?.subtitles?.[0];
    if (sub?.subtitle_url) {
      const j = await bili(sub.subtitle_url, `https://www.bilibili.com/video/${bvid}`);
      subtitle = (j?.body ?? []).map((x) => String(x?.content ?? '')).join(' ').slice(0, 6000);
    }
  } catch {}
  const visual = readJson(path.join(STATE, 'bili-video-summaries.json'), {})?.[bvid]?.summary ?? '';
  return {
    bvid,
    visual,
    title: String(d.title ?? title ?? ''),
    desc: String(d.desc ?? '').slice(0, 1200),
    tags: (d.tags ?? []).map((t) => t?.tag_name).filter(Boolean).slice(0, 10).join('、'),
    comments,
    subtitle,
  };
}

function skillNameSafe(name) {
  return String(name || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'learned-' + Date.now();
}

async function evaluate(material) {
  const v = cfg.socialV2?.vision ?? {};
  const key = cfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return null;
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const prompt = `判断下面这条 B 站视频材料是否值得形成一条“可复用的技能/方法”笔记。
只有内容里真的包含可迁移的方法、技巧、观点或经验时才值得；纯娱乐、纯新闻、纯情绪、信息太少都不值得。
值得时给出：name（不超过 20 字的中文技能名）、summary（一句话）、steps（3-6 步具体做法）。不值得时 worth=false。
只输出 JSON：{"worth":true,"name":"...","summary":"...","steps":["..."],"reason":"..."}
材料：
标题：${material.title}
简介：${material.desc}
标签：${material.tags}
热评：${material.comments.join(' / ').slice(0, 1500)}
画面描述：${material.visual.slice(0, 2000)}
字幕：${material.subtitle.slice(0, 3000)}`;
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 500, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim();
    const s = text.indexOf('{'); const e = text.lastIndexOf('}');
    return s >= 0 && e > s ? JSON.parse(text.slice(s, e + 1)) : null;
  } catch { return null; }
}

async function run(date) {
  const noteFile = path.join(NOTES, 'browse', `${date}.md`);
  if (!fs.existsSync(noteFile)) { log(`${date} 没有浏览笔记，跳过`); return { learned: 0 }; }
  const text = fs.readFileSync(noteFile, 'utf8');
  const items = [...text.matchAll(/\[B站\]\s*(.+?)（(BV[\w]+)）/g)].map((m) => ({ title: m[1].trim(), bvid: m[2] }));
  const seen = new Set();
  const unique = items.filter((x) => (seen.has(x.bvid) ? false : (seen.add(x.bvid), true))).slice(0, Number(arg('limit', 5)) || 5);
  if (!unique.length) { log(`${date} 笔记里没有 B 站视频，跳过`); return { learned: 0 }; }
  let learned = 0;
  const report = [];
  for (const item of unique) {
    try {
      const material = await materialFor(item.bvid, item.title);
      if (!material) continue;
      const decision = await evaluate(material);
      report.push({ bvid: item.bvid, title: material.title, decision });
      if (!decision?.worth) { log(`跳过：${material.title}（${decision?.reason ?? '评估不可用'}）`); continue; }
      const name = skillNameSafe(decision.name);
      const dir = path.join(SKILLS, name);
      const file = path.join(dir, 'SKILL.md');
      if (fs.existsSync(file)) { log(`已存在技能，跳过：${name}`); continue; }
      const body = `# ${decision.name}\n\n${decision.summary ?? ''}\n\n## 步骤\n\n${(decision.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## 来源\n\n- B 站：${material.title}（${item.bvid}）\n- 学到日期：${date}\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
      learned += 1;
      log(`学到新技能：${decision.name}（来自 ${item.bvid}）`);
    } catch (e) { log(`处理失败 ${item.bvid}：${e?.message ?? e}`); }
  }
  fs.mkdirSync(path.join(NOTES, 'learned'), { recursive: true });
  fs.writeFileSync(path.join(NOTES, 'learned', `${date}.md`), `# ${date} 学习评估\n\n${report.map((r) => `- ${r.title}（${r.bvid}）：${r.decision?.worth ? '值得 → ' + r.decision.name : '不值得 / ' + (r.decision?.reason ?? '无')}`).join('\n')}\n`, 'utf8');
  log(`${date} 学习完成：评估 ${report.length} 条，新增技能 ${learned} 条`);
  return { learned, evaluated: report.length };
}

const force = process.argv.includes('--now');
const dateArg = arg('date', null);
if (force) {
  const r = await run(dateArg && dateArg !== true ? String(dateArg) : today());
  process.exit(0);
}

try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
process.on('exit', () => { try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {} });
log('learn-daily 启动：每天 23:40 评估当天浏览内容');
setInterval(async () => {
  const now = new Date();
  if (now.getHours() < 23 || (now.getHours() === 23 && now.getMinutes() < 40)) return;
  const day = today();
  const state = readJson(STATE_FILE, { lastDate: '' });
  if (state.lastDate === day) return;
  try { await run(day); state.lastDate = day; writeJson(STATE_FILE, state); } catch (e) { log('失败：' + (e?.message ?? e)); }
}, 10 * 60 * 1000);
