// 分层记忆摘要：B站日/周/月 + 聊天日/周 + 画像 + 月度归档。
// 原始数据只追加，压缩只生成摘要，不删除原文。
// 用法：
//   node tools/memory-digest.mjs --level=daily [--date=YYYY-MM-DD] [--force]
//   node tools/memory-digest.mjs --level=weekly [--week=YYYY-Www]
//   node tools/memory-digest.mjs --level=monthly [--month=YYYY-MM]
//   node tools/memory-digest.mjs --level=archive [--month=YYYY-MM]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openMemory } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const MEM = path.join(ROOT, 'agent-home', 'memory');
const BILI_RAW = path.join(STATE, 'bili-watch-history.jsonl');
const BILI_MEM = path.join(STATE, 'bili-memory.json');
const LOG = path.join(MEM, 'memory-digest.log');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, f); };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoWeek = (d = new Date()) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - y) / 86400000) + 1) / 7)).padStart(2, '0')}`; };
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const startEndOfDay = (key) => { const d = new Date(key + 'T00:00:00'); return [d.getTime(), d.getTime() + 86400000]; };
const startEndOfWeek = (key) => { const [y, w] = String(key).split('-W').map(Number); const jan4 = new Date(Date.UTC(y, 0, 4)); const day = jan4.getUTCDay() || 7; const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - day + 1 + (w - 1) * 7); const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate()).getTime(); return [start, start + 7 * 86400000]; };
const startEndOfMonth = (key) => { const [y, m] = String(key).split('-').map(Number); const start = new Date(y, m - 1, 1).getTime(); const end = new Date(y, m, 1).getTime(); return [start, end]; };
const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function biliRecords(start, end) {
  const hist = readJsonl(BILI_RAW);
  const mem = (readJson(BILI_MEM, {}).videos || []);
  const map = new Map();
  for (const r of [...hist, ...mem]) {
    if (!r?.bvid || !r?.at) continue;
    const at = Number(r.at);
    if (at < start || at >= end) continue;
    const old = map.get(r.bvid) || {};
    map.set(r.bvid, { ...old, ...r, at });
  }
  return [...map.values()].sort((a, b) => a.at - b.at);
}
function chatEvents(start, end) {
  try {
    const db = openMemory();
    return db.prepare("SELECT occurred_at,source,actor_name,kind,text FROM events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at").all(start, end);
  } catch { return []; }
}
function compactLines(rows, max = 140) {
  return rows.map((e) => `- ${new Date(Number(e.occurred_at || e.at || 0)).toLocaleString('zh-CN', { hour12: false })} ${e.actor_name || e.source || ''}：${String(e.text || e.title || '').replace(/\s+/g, ' ').slice(0, max)}`).join('\n');
}
async function modelJson(prompt, fallback) {
  const v = cfg.socialV2?.vision || {};
  const key = cfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (key) {
    try {
      const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
      const r = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 600, thinking: { type: 'disabled' } }),
        signal: AbortSignal.timeout(45000)
      });
      const j = await r.json().catch(() => null);
      const text = String(j?.choices?.[0]?.message?.content || '');
      const a = text.indexOf('{'); const b = text.lastIndexOf('}');
      if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    } catch {}
  }
  return fallback;
}
const STOP = new Set(['画面', '图片', '视频', '消息', '一个', '这个', '我们', '他们', '就是', '什么', '没有', '自己', '可以', '感觉', '知道', '真的', '现在', '还是', '已经', '今天', 'the', 'and', 'you', 'speaker_00', 'speaker_01', 'speaker_02', 'boss']);
function topKeywords(texts, limit = 8) {
  const counts = new Map();
  for (const t of texts) {
    const s = String(t || '').toLowerCase();
    for (const w of s.match(/[\p{Script=Han}]{2,6}|[a-z0-9_]{3,}/gu) || []) { if (STOP.has(w) || /^speaker_/.test(w)) continue; counts.set(w, (counts.get(w) || 0) + 1); }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

async function daily(date = dayKey()) {
  const [start, end] = startEndOfDay(date);
  const bili = biliRecords(start, end);
  const chat = chatEvents(start, end);
  const biliText = bili.map((v) => `${v.title || ''}｜${v.interest || ''}｜${String(v.visual || '').slice(0, 220)}`).join('\n').slice(0, 6000);
  const chatText = compactLines(chat, 160).slice(0, 6000);
  const fallback = {
    summary: `今天看了 ${bili.length} 条B站，聊天 ${chat.length} 条。`,
    topics: topKeywords([...bili.map((x) => x.title), ...chat.map((x) => x.text)]),
    bilibili: { count: bili.length, themes: topKeywords(bili.map((x) => `${x.title || ''} ${x.interest || ''}`), 6) },
    chat: { count: chat.length, themes: topKeywords(chat.map((x) => x.text), 6) },
    mood: '',
    sourceCounts: { bili: bili.length, chat: chat.length }
  };
  const prompt = `你是记忆压缩器。把下面一天的内容压成 JSON，保留具体事实、人物、兴趣变化，不要编造：
{"summary":"100字内","topics":["..."],"bilibili":{"count":${bili.length},"themes":["..."]},"chat":{"count":${chat.length},"themes":["..."]},"mood":"","sourceCounts":{"bili":${bili.length},"chat":${chat.length}}}
B站：\n${biliText || '无'}\n聊天：\n${chatText || '无'}`;
  const out = await modelJson(prompt, fallback);
  // 日摘要用抽取式事实句，避免模型为了“写满”补出素材里没有的课程/人物/事件；
  // 模型只保留主题与情绪标签，summary 始终由当天真实计数和关键词生成。
  const themes = topKeywords([...bili.map((x) => x.title), ...chat.map((x) => x.text)], 8);
  const biliThemes = topKeywords(bili.map((x) => `${x.title || ''} ${x.interest || ''}`), 6);
  const chatThemes = topKeywords(chat.map((x) => x.text), 6);
  const data = { date, summary: `${date}：B站 ${bili.length} 条，主要涉及 ${biliThemes.join('、') || '无'}；聊天 ${chat.length} 条，主要涉及 ${chatThemes.join('、') || '无'}。`, topics: themes, bilibili: { count: bili.length, themes: biliThemes }, chat: { count: chat.length, themes: chatThemes }, mood: String(out.mood || ''), generatedAt: Date.now(), sources: { bili: bili.length, chat: chat.length } };
  writeJson(path.join(MEM, 'daily', date + '.json'), data);
  log(`日摘要 ${date}：B站 ${bili.length}，聊天 ${chat.length}`);
  return data;
}

async function weekly(week = isoWeek()) {
  const [start, end] = startEndOfWeek(week);
  const days = [];
  for (let t = start; t < end; t += 86400000) { const f = path.join(MEM, 'daily', dayKey(new Date(t)) + '.json'); const d = readJson(f, null); if (d) days.push(d); }
  const bili = biliRecords(start, end);
  const chat = chatEvents(start, end);
  const fallback = { summary: `本周看了 ${bili.length} 条B站，聊天 ${chat.length} 条。`, themes: topKeywords([...bili.map((x) => x.title), ...chat.map((x) => x.text)]), interestChanges: [], bilibili: { count: bili.length, themes: topKeywords(bili.map((x) => `${x.title || ''} ${x.interest || ''}`), 8) }, chat: { count: chat.length, themes: topKeywords(chat.map((x) => x.text), 8) } };
  const prompt = `把下面一周的日摘要压成 JSON，重点提炼主题、兴趣变化、人物和未完事项，不要编造：
{"summary":"150字内","themes":["..."],"interestChanges":["..."],"bilibili":{"count":${bili.length},"themes":["..."]},"chat":{"count":${chat.length},"themes":["..."]}}
日摘要：${JSON.stringify(days).slice(0, 7000)}`;
  const out = await modelJson(prompt, fallback);
  const data = { week, ...out, bilibili: { ...(out.bilibili || {}), count: bili.length }, chat: { ...(out.chat || {}), count: chat.length }, generatedAt: Date.now() };
  writeJson(path.join(MEM, 'weekly', week + '.json'), data);
  await updateBiliProfile(bili, week);
  log(`周摘要 ${week}：B站 ${bili.length}，聊天 ${chat.length}`);
  return data;
}

async function monthly(month = monthKey()) {
  const [start, end] = startEndOfMonth(month);
  const weeks = [];
  for (let t = start; t < end; t += 7 * 86400000) { const f = path.join(MEM, 'weekly', isoWeek(new Date(t)) + '.json'); const d = readJson(f, null); if (d) weeks.push(d); }
  const bili = biliRecords(start, end);
  const chat = chatEvents(start, end);
  const fallback = { summary: `本月B站 ${bili.length} 条，聊天 ${chat.length} 条。`, themes: topKeywords([...bili.map((x) => x.title), ...chat.map((x) => x.text)]), bilibili: { count: bili.length, themes: topKeywords(bili.map((x) => `${x.title || ''} ${x.interest || ''}`), 10) }, chat: { count: chat.length, themes: topKeywords(chat.map((x) => x.text), 8) } };
  const prompt = `把下面一个月的周摘要压成 JSON，保留长期主题、稳定兴趣、关系变化、反复出现的事情：
{"summary":"200字内","themes":["..."],"interestChanges":["..."],"bilibili":{"count":${bili.length},"themes":["..."]},"chat":{"count":${chat.length},"themes":["..."]}}
周摘要：${JSON.stringify(weeks).slice(0, 8000)}`;
  const out = await modelJson(prompt, fallback);
  const data = { month, ...out, bilibili: { ...(out.bilibili || {}), count: bili.length }, chat: { ...(out.chat || {}), count: chat.length }, generatedAt: Date.now() };
  writeJson(path.join(MEM, 'monthly', month + '.json'), data);
  await updateBiliProfile(bili, month);
  log(`月摘要 ${month}：B站 ${bili.length}，聊天 ${chat.length}`);
  return data;
}

async function updateBiliProfile(records, period) {
  const file = path.join(MEM, 'profile', 'bilibili.json');
  const old = readJson(file, { interests: [], updatedAt: 0, periods: [] });
  const BAD = /^(模拟器推荐|随机推荐|兴趣|B站|封面语义|的版本|v50|v50的版本)$/i;
  const counts = new Map();
  for (const r of records) {
    const raw = String(r.interest || '').replace(/^兴趣[:：]?/, '').trim();
    for (const x of raw.split(/[\/、,，\s]+/)) {
      const name = String(x || '').trim();
      if (name.length < 2 || BAD.test(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const existing = new Map((old.interests || []).map((x) => [x.name, x]));
  for (const e of existing.values()) if (BAD.test(String(e.name || ''))) e.status = 'ignored';
  const norm = (s) => String(s || '').replace(/^兴趣[:：]?/, '').replace(/[（）()]/g, '').trim();
  const bigrams = (s) => { const a = []; const x = norm(s); for (let i = 0; i < x.length - 1; i++) a.push(x.slice(i, i + 2)); return new Set(a); };
  const sim = (a, b) => { const A = bigrams(a); const B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.max(A.size, B.size); };
  for (const [name, count] of top) {
    const e = existing.get(name) || { name, weight: 0, firstSeen: Date.now(), status: 'active' };
    e.weight = Math.min(5, Number(e.weight || 0) + Math.min(1, count / 5));
    e.lastSeenAt = Date.now(); e.evidenceCount = (e.evidenceCount || 0) + count; e.status = 'active';
    // 语义去重：旧兴趣相似且新证据更多时，只把旧的标记 superseded，不删除。
    for (const other of existing.values()) {
      if (other === e || other.status === 'ignored' || other.status === 'superseded') continue;
      if (sim(e.name, other.name) >= 0.6 && Number(e.evidenceCount || 0) > Number(other.evidenceCount || 0)) { other.status = 'superseded'; other.supersededBy = e.name; }
    }
    existing.set(name, e);
  }
  for (const e of existing.values()) if (e.status === 'active' && Date.now() - Number(e.lastSeenAt || 0) > 30 * 86400000) e.status = 'dormant';
  writeJson(file, { updatedAt: Date.now(), interests: [...existing.values()].sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0)), periods: [...(old.periods || []).slice(-12), period] });
}

function archive(month = monthKey()) {
  const [start, end] = startEndOfMonth(month);
  const records = readJsonl(BILI_RAW).filter((r) => Number(r.at) >= start && Number(r.at) < end);
  const raw = records.map((r) => JSON.stringify(r)).join('\n');
  if (!raw) { log(`归档 ${month}：无记录`); return; }
  const outDir = path.join(MEM, 'archive'); fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `bili-${month}.jsonl.zst`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, zlib.zstdCompressSync(Buffer.from(raw, 'utf8')));
  // 同时保留未压缩副本，原始 bili-watch-history.jsonl 不删除。
  const plain = path.join(outDir, `bili-${month}.jsonl`);
  if (!fs.existsSync(plain)) fs.writeFileSync(plain, raw + '\n', 'utf8');
  log(`归档 ${month}：${records.length} 条 -> ${target}`);
}

const args = process.argv.slice(2);
const level = (args.find((x) => x.startsWith('--level=')) || '').split('=')[1] || 'daily';
const date = (args.find((x) => x.startsWith('--date=')) || '').split('=')[1];
const week = (args.find((x) => x.startsWith('--week=')) || '').split('=')[1];
const month = (args.find((x) => x.startsWith('--month=')) || '').split('=')[1];
try {
  if (level === 'daily') await daily(date || dayKey());
  else if (level === 'weekly') await weekly(week || isoWeek());
  else if (level === 'monthly') await monthly(month || monthKey());
  else if (level === 'archive') archive(month || monthKey());
  else { console.error('level must be daily|weekly|monthly|archive'); process.exit(2); }
} catch (e) { log('失败：' + (e?.message ?? e)); process.exit(1); }
