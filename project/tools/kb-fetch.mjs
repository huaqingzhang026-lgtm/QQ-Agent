// 把"群聊关键词"拿去 B站/微博/小红书搜，结果存成本地知识库。
//
// 用法：
//   node tools\kb-fetch.mjs --pending              # 搜 state\chat-keywords.json 里所有 pending
//   node tools\kb-fetch.mjs --keywords 黑神话,舰长   # 临时指定关键词
//   node tools\kb-fetch.mjs --pending --limit 2 --per 3 --platforms bili,weibo,xhs
//
// 产物：
//   agent-home\kb\<platform>\<YYYY-MM-DD>.md   （人看的日报式笔记）
//   agent-home\kb\index.jsonl                  （机器索引，一条结果一行，按 platform+id 去重）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const KB = path.join(ROOT, 'agent-home', 'kb');
const INDEX = path.join(KB, 'index.jsonl');
const KEYWORDS = path.join(STATE, 'chat-keywords.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

const perPlatform = Math.max(1, Math.min(Number(arg('per', 3)) || 3, 10));
const maxKeywords = Math.max(1, Math.min(Number(arg('limit', 3)) || 3, 20));
const platforms = String(arg('platforms', 'bili,weibo,xhs')).split(/[,，\s]+/).filter(Boolean);

// ── 关键词来源 ─────────────────────────────────────────────────────────────
let keywords = [];
const kwArg = arg('keywords', null);
if (kwArg && kwArg !== true) keywords = String(kwArg).split(/[,，、\s]+/).filter(Boolean);
else {
  const st = readJson(KEYWORDS, { pending: [] });
  keywords = (st.pending ?? []).map((p) => p.kw);
}
keywords = [...new Set(keywords)].slice(0, maxKeywords);
if (!keywords.length) { console.log('没有待搜关键词'); process.exit(0); }

// ── 各平台搜索 ─────────────────────────────────────────────────────────────
const biliCookie = (() => {
  const c = readJson(path.join(ROOT, 'bili-mcp', 'cookie.json'), {});
  return c.sessdata ? `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; DedeUserID=${c.dede_user_id}` : '';
})();
const weiboCookie = (() => {
  const c = readJson(path.join(ROOT, 'weibo-mcp', 'cookie.json'), {});
  return Object.entries(c).filter(([k, v]) => typeof v === 'string' && v && k !== 'updatedAt' && k !== 'uid').map(([k, v]) => `${k}=${v}`).join('; ');
})();

async function jsonFetch(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(text);
}

let biliChild = null, biliRl = null, biliId = 0, biliWaiters = new Map();
async function biliMcp(tool, args) {
  if (!biliChild) {
    const { spawn } = await import('node:child_process');
    const { default: readline } = await import('node:readline');
    biliChild = spawn(process.execPath, [path.join(ROOT, 'bili-mcp', 'run.mjs')], { cwd: path.join(ROOT, 'bili-mcp'), stdio: ['pipe', 'pipe', 'ignore'] });
    biliRl = readline.createInterface({ input: biliChild.stdout });
    biliRl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch { return; } const w = biliWaiters.get(m.id); if (w) { biliWaiters.delete(m.id); w(m); } });
    await new Promise((resolve) => {
      const id = ++biliId;
      biliWaiters.set(id, () => resolve());
      biliChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kb', version: '1' } } }) + '\n');
      biliChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    });
  }
  const id = ++biliId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { biliWaiters.delete(id); reject(new Error('bili MCP 超时')); }, 60000);
    biliWaiters.set(id, (m) => { clearTimeout(timer); resolve((m.result?.content ?? []).map((c) => c.text ?? '').join(' ')); });
    biliChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
  });
}

async function searchBili(kw) {
  const text = await biliMcp('bilibili_search', { keyword: kw });
  const out = [];
  const blocks = String(text).split(/\n(?=\d+\. )/);
  for (const b of blocks) {
    const title = /^\d+\.\s*(.+)$/m.exec(b)?.[1]?.trim();
    const bv = /BV([0-9A-Za-z]{10})/.exec(b)?.[0];
    const author = /UP主:\s*([^\n(]+)/.exec(b)?.[1]?.trim();
    if (!title || !bv) continue;
    out.push({ platform: 'bili', id: bv, title: strip(title), author: author ?? '', url: 'https://www.bilibili.com/video/' + bv, metrics: {}, time: '' });
    if (out.length >= perPlatform) break;
  }
  return out;
}

async function searchWeibo(kw) {
  const url = `https://m.weibo.cn/api/container/getIndex?containerid=${encodeURIComponent(`100103type=1&q=${kw}`)}&page_type=searchall`;
  const j = await jsonFetch(url, { referer: 'https://m.weibo.cn/', ...(weiboCookie ? { cookie: weiboCookie } : {}) });
  const cards = j?.data?.cards ?? [];
  const out = [];
  for (const c of cards) {
    for (const g of c.card_group ?? []) {
      const m = g.mblog;
      if (!m) continue;
      out.push({
        platform: 'weibo', id: String(m.id), title: strip(m.text).slice(0, 120), author: m.user?.screen_name ?? '',
        url: `https://m.weibo.cn/detail/${m.id}`,
        metrics: { likes: m.attitudes_count, comments: m.comments_count, reposts: m.reposts_count },
        time: m.created_at ?? '',
      });
      if (out.length >= perPlatform) return out;
    }
    if (c.mblog) {
      const m = c.mblog;
      out.push({ platform: 'weibo', id: String(m.id), title: strip(m.text).slice(0, 120), author: m.user?.screen_name ?? '', url: `https://m.weibo.cn/detail/${m.id}`, metrics: { likes: m.attitudes_count, comments: m.comments_count, reposts: m.reposts_count }, time: m.created_at ?? '' });
    }
    if (out.length >= perPlatform) return out;
  }
  return out;
}

// 小红书走本地 MCP（streamable HTTP）
let xhsSession = null;
function parseMcpBody(text) {
  if (text.trim().startsWith('{')) { try { return JSON.parse(text); } catch { return null; } }
  const lines = text.split('\n').filter((l) => l.startsWith('data:'));
  for (const l of lines.reverse()) { const p = l.replace(/^data:\s*/, '').trim(); if (!p) continue; try { return JSON.parse(p); } catch {} }
  return null;
}
async function xhsRpc(method, params, notification = false) {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
  if (!notification) body.id = 1;
  const res = await fetch('http://127.0.0.1:18060/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(xhsSession ? { 'mcp-session-id': xhsSession } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const sid = res.headers.get('mcp-session-id'); if (sid) xhsSession = sid;
  const text = await res.text();
  return notification ? null : parseMcpBody(text);
}

async function searchXhs(kw) {
  if (!xhsSession) {
    await xhsRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kb-fetch', version: '1' } });
    await xhsRpc('notifications/initialized', undefined, true);
  }
  let r = null;
  for (let attempt = 0; attempt < 2 && !r; attempt++) {
    try { r = await xhsRpc('tools/call', { name: 'search_feeds', arguments: { keyword: kw } }); }
    catch (e) { if (attempt === 1) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const txt = (r?.result?.content ?? []).map((c) => c.text ?? '').join(' ');
  // 2026-10-28 修（⑳）：xhs 服务挂掉时，MCP 会正常返回 HTTP 200，
  // 但 result 里是 { isError: true, content:[{text:'…Failed to get the debug url…'}] }。
  // 原来这里直接 JSON.parse 失败 → feeds=[] → 上层记成「0 条」，
  // 于是知识库的小红书来源断了 5 天都没人发现。现在让失败说话。
  if (r?.result?.isError) {
    throw new Error(`xhs 返回错误：${String(txt).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  let data = null;
  try { data = JSON.parse(txt); } catch {}
  if (!data) throw new Error(`xhs 返回无法解析：${String(txt).replace(/\s+/g, ' ').slice(0, 120)}`);
  const feeds = data?.feeds ?? [];
  return feeds.slice(0, perPlatform).map((f) => ({
    platform: 'xhs', id: String(f.id), title: strip(f.noteCard?.displayTitle || f.noteCard?.desc || '(无标题)').slice(0, 80),
    author: f.noteCard?.user?.nickname ?? '', url: `https://www.xiaohongshu.com/explore/${f.id}`,
    metrics: { likes: f.noteCard?.interactInfo?.likedCount ?? '', collected: f.noteCard?.interactInfo?.collectedCount ?? '' }, time: '',
  }));
}

const SEARCHERS = { bili: searchBili, weibo: searchWeibo, xhs: searchXhs };

// ── 抓 + 落库 ──────────────────────────────────────────────────────────────
fs.mkdirSync(KB, { recursive: true });
const seen = new Set();
if (fs.existsSync(INDEX)) {
  for (const line of fs.readFileSync(INDEX, 'utf8').split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); seen.add(`${j.platform}:${j.id}`); } catch {}
  }
}

const collected = [];
for (const kw of keywords) {
  for (const p of platforms) {
    const fn = SEARCHERS[p];
    if (!fn) { console.log(`跳过未知平台 ${p}`); continue; }
    try {
      const items = await fn(kw);
      const fresh = items.filter((x) => !seen.has(`${x.platform}:${x.id}`));
      for (const x of fresh) { x.keyword = kw; x.fetchedAt = new Date().toISOString(); seen.add(`${x.platform}:${x.id}`); collected.push(x); }
      console.log(`${p} 「${kw}」→ ${items.length} 条（新 ${fresh.length}）`);
    } catch (e) {
      console.log(`${p} 「${kw}」失败：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

if (!collected.length) { console.log('没有新内容'); process.exit(0); }

fs.appendFileSync(INDEX, collected.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

// 按平台+日期写 markdown（给人看，也会被 memory_search 索引到）
const byPlatform = {};
for (const x of collected) (byPlatform[x.platform] ??= []).push(x);
for (const [p, items] of Object.entries(byPlatform)) {
  fs.mkdirSync(path.join(KB, p), { recursive: true });
  const file = path.join(KB, p, `${day()}.md`);
  const lines = [`\n## ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 抓取\n`];
  for (const x of items) {
    lines.push(`- **${x.title}** — @${x.author || '?'}（关键词：${x.keyword}）`);
    lines.push(`  ${x.url}`);
  }
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`写入 kb\\${p}\\${day()}.md（${items.length} 条）`);
}

// 标记关键词已处理
if (!kwArg) {
  const st = readJson(KEYWORDS, { pending: [], processed: [] });
  const done = new Set(keywords);
  st.pending = (st.pending ?? []).filter((x) => !done.has(x.kw));
  st.processed = [...new Set([...(st.processed ?? []), ...keywords])].slice(-300);
  st.updatedAt = new Date().toISOString();
  fs.writeFileSync(KEYWORDS, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  console.log(`已标记处理 ${keywords.length} 个关键词（pending 剩 ${st.pending.length}）`);
}

console.log(`\n共入库 ${collected.length} 条：${Object.entries(byPlatform).map(([p, l]) => `${p} ${l.length}`).join(' / ')}`);

try { biliChild?.kill(); } catch {}
process.exit(0);
