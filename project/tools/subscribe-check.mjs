// 订阅 + 推送：盯着几个源，有新东西就记笔记 + 给主人发一条 QQ。
//
// 配置：<工作区>\subscriptions.json（首次运行会自动生成一份默认配置）
//   {
//     "targets": [
//       { "id": "weibo-hot-ai", "kind": "weibo_hot", "keywords": ["AI", "大模型", "DeepSeek", "机器人"] },
//       { "id": "bili-946974", "kind": "bili_dynamic", "uid": 946974, "name": "影视飓风" },
//       { "id": "rss-sspai", "kind": "rss", "url": "https://sspai.com/feed", "name": "少数派" }
//     ]
//   }
//
// 用法：node tools\subscribe-check.mjs [--no-send] [--seed] [--force]
//   --seed  只记录当前内容为"已读"，不推送（首次安装用）
//   --force 忽略作息时间（默认 08:00-24:00 才推）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = path.join(ROOT, 'subscriptions.json');
const STATE_FILE = path.join(ROOT, 'qq-bridge', 'state', 'subscriptions-state.json');
const NOTES = path.join(ROOT, 'agent-home', 'notes', 'subscriptions');
const LOG = path.join(ROOT, 'tools', 'subscribe.log');

const noSend = process.argv.includes('--no-send');
const seed = process.argv.includes('--seed');
const force = process.argv.includes('--force');
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const log = (m) => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } }

const DEFAULT_CONF = {
  targets: [
    { id: 'weibo-hot-ai', kind: 'weibo_hot', keywords: ['AI', '人工智能', '大模型', 'DeepSeek', '机器人'] },
    { id: 'bili-946974', kind: 'bili_dynamic', uid: 946974, name: '影视飓风' },
  ],
};
if (!fs.existsSync(CONF)) { fs.writeFileSync(CONF, `${JSON.stringify(DEFAULT_CONF, null, 2)}\n`, 'utf8'); log(`已生成默认配置：${CONF}`); }
const conf = readJson(CONF, DEFAULT_CONF);
const state = readJson(STATE_FILE, {});

const cookie = readJson(path.join(ROOT, 'bili-mcp', 'cookie.json'), {});
const BILI_COOKIE = cookie.sessdata ? `SESSDATA=${cookie.sessdata}; bili_jct=${cookie.bili_jct}; DedeUserID=${cookie.dede_user_id}` : '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return JSON.parse(text); } catch { throw new Error('非 JSON 响应'); }
}

// ── 各来源：返回 [{id, title, url, extra}] ───────────────────────────────────
async function weiboHot(t) {
  const j = await fetchJson('https://weibo.com/ajax/statuses/hot_band', { headers: { referer: 'https://weibo.com/' } });
  const list = j.data?.band_list ?? [];
  const words = (t.keywords ?? []).map((k) => String(k).toLowerCase());
  return list
    .filter((x) => {
      const w = String(x.word ?? '').toLowerCase();
      return words.some((k) => w.includes(k));
    })
    .slice(0, 8)
    .map((x) => ({
      id: `weibo:${x.word}`,
      title: `${x.word}（热度 ${x.num ?? x.raw_hot ?? '?'}${x.is_new ? '，新' : ''}）`,
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(x.word)}`,
    }));
}

async function biliDynamic(t) {
  const j = await fetchJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(t.uid)}`, {
    headers: { referer: `https://space.bilibili.com/${t.uid}`, ...(BILI_COOKIE ? { cookie: BILI_COOKIE } : {}) },
  });
  if (j.code !== 0) throw new Error(`bili code ${j.code} ${j.message ?? ''}`);
  return (j.data?.items ?? []).slice(0, 6).map((it) => {
    const mod = it.modules ?? {};
    const title = mod.module_dynamic?.major?.archive?.title
      ?? mod.module_dynamic?.desc?.text
      ?? mod.module_dynamic?.major?.draw?.items?.[0]?.desc
      ?? '(无文字动态)';
    const bvid = mod.module_dynamic?.major?.archive?.bvid;
    return {
      id: `bili:${it.id_str}`,
      title: String(title).replace(/\s+/g, ' ').slice(0, 80),
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://t.bilibili.com/${it.id_str}`,
    };
  });
}

function xmlItems(xml) {
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
    };
    const link = pick('link') || pick('guid');
    const title = pick('title');
    if (!link || !title) continue;
    items.push({ id: `rss:${link}`, title: title.slice(0, 90), url: link });
  }
  return items;
}

async function rss(t) {
  const res = await fetch(t.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return xmlItems(await res.text()).slice(0, 10);
}

const SOURCES = { weibo_hot: weiboHot, bili_dynamic: biliDynamic, rss };

// ── 主流程 ──────────────────────────────────────────────────────────────────
const hour = new Date().getHours();
if (!force && (hour < 8 || hour >= 24)) { log('作息外（0-8 点），跳过推送'); process.exit(0); }

const pushes = [];
for (const t of conf.targets ?? []) {
  if (!t?.id || !SOURCES[t.kind]) { log(`跳过未知订阅：${JSON.stringify(t)}`); continue; }
  try {
    const items = await SOURCES[t.kind](t);
    const seen = new Set(state[t.id] ?? []);
    const fresh = items.filter((x) => !seen.has(x.id));
    // 首次见到这个目标：只记录，不推（避免一口气把历史全推给你）
    if (!state[t.id]) {
      state[t.id] = items.map((x) => x.id).slice(0, 200);
      log(`${t.id}：首次建立基线 ${items.length} 条`);
      continue;
    }
    if (seed) {
      state[t.id] = [...new Set([...items.map((x) => x.id), ...(state[t.id] ?? [])])].slice(0, 200);
      log(`${t.id}：seed 记录 ${items.length} 条`);
      continue;
    }
    if (fresh.length) {
      state[t.id] = [...new Set([...items.map((x) => x.id), ...(state[t.id] ?? [])])].slice(0, 200);
      const label = t.name ?? t.id;
      pushes.push({ label, items: fresh.slice(0, 3) });
      log(`${t.id}：新内容 ${fresh.length} 条（${fresh.slice(0, 2).map((x) => x.title).join(' / ')}）`);
    }
  } catch (e) {
    log(`${t.id} 检查失败：${e.message}`);
  }
}

// 落笔记 + 给她攒"聊天素材"（不推给主人）
if (pushes.length) {
  fs.mkdirSync(NOTES, { recursive: true });
  const now = new Date();
  const stamp = now.toLocaleTimeString('zh-CN', { hour12: false });
  const file = path.join(NOTES, `${localDay(now)}.md`);
  const flat = pushes.flatMap((p) => p.items.map((x) => ({ label: p.label, ...x, at: now.toISOString() })));
  const lines = flat.map((x) => `- [${x.label}] ${x.title} — ${x.url}`);
  fs.appendFileSync(file, `\n## ${stamp}\n${lines.join('\n')}\n`, 'utf8');
  fs.appendFileSync(path.join(NOTES, 'inbox.md'), `\n## ${localDay(now)} ${stamp}\n${lines.join('\n')}\n`, 'utf8');
  log(`写入笔记：${path.relative(ROOT, file)}（${flat.length} 条）`);

  // 给她自己看的"素材池"：memory MCP 的 subscription_inbox 读这个
  const POOL = path.join(ROOT, 'qq-bridge', 'state', 'subscription-new.json');
  const pool = readJson(POOL, { items: [] });
  pool.items = [...flat, ...(pool.items ?? [])].slice(0, 40);
  pool.updatedAt = now.toISOString();
  fs.writeFileSync(POOL, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
}

// 只有显式 --send 才推给主人（默认不发）
if (pushes.length && !noSend && process.argv.includes('--send')) {
  const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
  const base = (cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = cfg.snowluma?.accessToken ?? '';
  const total = pushes.reduce((n, p) => n + p.items.length, 0);
  const body = [
    `📡 订阅有新内容（${total} 条）`,
    ...pushes.map((p) => `${p.label}：\n${p.items.map((x) => `· ${x.title}\n  ${x.url}`).join('\n')}`),
  ].join('\n').slice(0, 900);
  const owner = String(cfg.ownerQQ ?? '10001');
  try {
    // 统一出口（F03）：走桥接 /api/outbound/notify；拒绝/不可用即失败，不回退直连。
    const consoleToken = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'state', 'console-token'), 'utf8').trim();
    const res = await fetch('http://127.0.0.1:3100/api/outbound/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ key: 'private:' + owner, text: body, exempt: false }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (j.ok) log(`已推送 message_id=${j.messageId ?? '?'}`);
    else log(`推送失败：${JSON.stringify(j).slice(0, 200)}`);
  } catch (e) { log(`推送异常：${e.message}`); }
}

fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
log(`完成：检查 ${(conf.targets ?? []).length} 个订阅，新内容 ${pushes.reduce((n, p) => n + p.items.length, 0)} 条`);
