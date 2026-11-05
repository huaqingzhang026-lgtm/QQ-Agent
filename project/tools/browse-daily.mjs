// 每日刷一刷：B站 / 微博 / 小红书，读内容 + 评论区互动（评论/点赞）。
//
// 设计：
//   · 每天多个时段（默认 09:30 / 13:30 / 18:30 / 21:30），每个时段刷一轮；
//   · B站：热门视频 → 看标题/简介/热评 → 生成一句评论 → 可发评论/点赞（有每日上限）；
//   · 微博：热搜 → 读几条 → 写“今天看到什么”的笔记（评论接口风控严，默认只读）；
//   · 小红书：通过 18060 的 MCP 调 search_feeds/get_feed_detail/post_comment_to_feed；
//   · 一律写进 agent-home/notes/browse/日期.md，不刷屏、不发广告。
//
// 默认 dryRun=true：只生成、不真的发评论；确认内容质量后再关掉。

import fs from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canTopComment, canReply, noteTopComment, noteReply } from '../qq-bridge/src/browse-quota.js';
import { ensureInterests, pickWeighted, ridFor, popularPage, rankingByRid, relatedTo } from './bili-discovery.mjs';
import { ensureCommentStyle, appendCommentSamples } from './comment-style.mjs';
import { summarizeBiliVideo } from './bili-watch.mjs';
import { describeVisuals } from '../qq-bridge/src/vision.js';
import { addPlatformItem } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'qq-bridge', 'state');
const CONF_FILE = path.join(STATE_DIR, 'browse.json');
const STATE_FILE = path.join(STATE_DIR, 'browse-state.json');
const COOKIE_FILE = path.join(ROOT, 'bili-mcp', 'cookie.json');
const LOG_FILE = path.join(STATE_DIR, 'browse.log');
const NOTES_DIR = path.join(ROOT, 'agent-home', 'notes', 'browse');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const DEFAULTS = {
  enabled: true,
  dryRun: true,
  slots: ['09:10', '10:40', '12:10', '13:40', '15:10', '16:40', '18:10', '19:40', '21:10', '22:40'],
  daily: { biliRead: 10, biliTopComments: 15, biliRepliesPerHour: 30, likes: 30, weiboRead: 8, xhsRead: 3, xhsComments: 4, xhsKeywords: ['日常', '猫'] },
  minCommentGapMs: 120000,
};

const PID_FILE = path.join(STATE_DIR, 'browse.pid');
try {
  const old = Number(fs.readFileSync(PID_FILE, 'utf8'));
  if (old && old !== process.pid) { try { process.kill(old, 0); console.log('browse already running pid=' + old); process.exit(0); } catch {} }
} catch {}
try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
process.on('exit', () => { try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {} });
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {} };
let biliAuthCache = { ok: false, at: 0, reason: '' };
async function notifyOwnerOnce(text) {
  const file = path.join(STATE_DIR, 'bili-auth-notice.json');
  const now = Date.now();
  const old = readJson(file, {});
  if (Number(old.at || 0) && now - Number(old.at) < 6 * 60 * 60 * 1000) return;
  writeJson(file, { at: now, text: String(text).slice(0, 200) });
  try {
    await fetch('http://127.0.0.1:3100/api/outbound/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'private:' + String(fullCfg.ownerQQ || ''), text: String(text).slice(0, 600), exempt: true, record: true }), signal: AbortSignal.timeout(10000) });
  } catch {}
}
async function checkBiliAuth(force = false) {
  const now = Date.now();
  if (!force && biliAuthCache.at && now - biliAuthCache.at < 10 * 60 * 1000) return biliAuthCache;
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(BILI_COOKIE ? { cookie: BILI_COOKIE } : {}) }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const ok = j?.code === 0 && j?.data?.isLogin === true;
    biliAuthCache = { ok, at: now, reason: ok ? '' : (j?.message || ('code=' + (j?.code ?? '?'))) };
    if (!ok) { log('B站评论预检失败：' + biliAuthCache.reason + '；本轮暂停写操作'); await notifyOwnerOnce('⚠️ B站登录态失效，已暂停评论/点赞：' + biliAuthCache.reason); }
    else log('B站评论预检通过：' + (j?.data?.uname || '已登录'));
    return biliAuthCache;
  } catch (e) {
    biliAuthCache = { ok: false, at: now, reason: e?.message || 'nav failed' };
    log('B站评论预检异常：' + biliAuthCache.reason + '；本轮暂停写操作');
    await notifyOwnerOnce('⚠️ B站登录态检查失败，已暂停评论/点赞：' + biliAuthCache.reason);
    return biliAuthCache;
  }
}
async function markBiliAuthLost(code, message) {
  biliAuthCache = { ok: false, at: Date.now(), reason: 'code=' + code + ' ' + String(message || '') };
  log('B站写操作返回 ' + biliAuthCache.reason + '，暂停本轮后续写操作');
  await notifyOwnerOnce('⚠️ B站写操作失败，已暂停评论/点赞：' + biliAuthCache.reason);
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };
const today = () => new Date().toISOString().slice(0, 10);

let conf = readJson(CONF_FILE, null);
if (!conf) { conf = DEFAULTS; writeJson(CONF_FILE, conf); log(`已生成默认 browse.json`); }
conf = { ...DEFAULTS, ...conf, daily: { ...DEFAULTS.daily, ...(conf.daily ?? {}) } };
if (conf.enabled === false) { log('browse 未启用，退出'); process.exit(0); }

let state = readJson(STATE_FILE, { date: today(), doneSlots: [], topComments: 0, replies: [], likes: 0, lastCommentAt: 0, seenBvids: [] });
if (state.date !== today()) state = { date: today(), doneSlots: [], topComments: 0, replies: [], likes: 0, lastCommentAt: 0, seenBvids: [], biliSelectedHour: 0, biliHourKey: '' };
if (!Array.isArray(state.seenBvids)) state.seenBvids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookieHeader() {
  const c = readJson(COOKIE_FILE, {});
  if (!c.sessdata) return '';
  if (c.full_cookie) return String(c.full_cookie);
  return [`SESSDATA=${c.sessdata}`, `bili_jct=${c.bili_jct}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : '', c.buvid3 ? `buvid3=${c.buvid3}` : ''].filter(Boolean).join('; ');
}
const BILI_COOKIE = cookieHeader();

async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com', ...(BILI_COOKIE ? { cookie: BILI_COOKIE } : {}), ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(15000), ...opts });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, raw: text.slice(0, 200) }; }
}

// ── MiMo 生成一句评论/感想 ────────────────────────────────────────────────
const fullCfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
async function genComment(kind, ctx) {
  const styleText = await ensureCommentStyle({ stateDir: STATE_DIR, fullCfg, log });
  const v = fullCfg.socialV2?.vision ?? {};
  const key = fullCfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const styles = ['像刚看完随口吐槽一句', '像刷到好笑的接个梗', '像认真看完夸一个具体点', '像有点疑惑地问一句', '像跟朋友分享一句感受'];
  const style = styles[Math.floor(Math.random() * styles.length)];
  let prompt = `你是一个18岁女生，正在刷${kind}。用一句自然、口语化、像真人的评论回应下面的内容（不超过 35 字），这条要${style}；不要广告、不要链接、不要@人、不要引号，只输出评论正文。
内容：
${String(ctx).slice(0, 800)}`;
  if (styleText) prompt = prompt.replace('内容：', '参考这个评论区的说话风格：' + styleText + '\n内容：');
  try {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 100, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return String(j?.choices?.[0]?.message?.content ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  } catch { return ''; }
}

function appendNote(slot, lines) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const file = path.join(NOTES_DIR, `${today()}.md`);
  const header = fs.existsSync(file) ? '' : `# 刷到的东西（${today()}）\n\n`;
  fs.appendFileSync(file, header + `## ${slot}\n\n${lines.join('\n')}\n\n`, 'utf8');
}

// ── 模拟器推荐流 → 标题 → cookie 搜索 ─────────────────────────────────────
function adbConf() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'android-mcp', 'config.json'), 'utf8')); } catch { return {}; }
}
async function adbRun(args, timeout = 30000) {
  const c = adbConf();
  const adb = String(c.adb || 'adb');
  const serial = String(c.serial || '127.0.0.1:7555');
  try {
    const r = await execFile(adb, ['-s', serial, ...args], { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return String(r.stdout || '');
  } catch (e) {
    return String(e?.stdout || '');
  }
}
async function androidFeedTitles() {
  try {
    const focus = await adbRun(['shell', 'dumpsys', 'window']);
    if (!/mCurrentFocus=.*tv\.danmaku\.bili/.test(focus)) {
      await adbRun(['shell', 'monkey', '-p', 'tv.danmaku.bili', '-c', 'android.intent.category.LAUNCHER', '1']);
      await sleep(5000);
    }
    const titles = [];
    const seen = new Set();
    for (let screen = 0; screen < 6 && titles.length < 40; screen++) {
      await adbRun(['shell', 'uiautomator', 'dump', '/sdcard/bili-feed.xml']);
      const xml = await adbRun(['shell', 'cat', '/sdcard/bili-feed.xml']);
      for (const m of xml.matchAll(/<node[^>]*text="([^"]{8,100})"[^>]*>/g)) {
        const s = m[1].replace(/&amp;/g, '&').replace(/&#10;/g, ' ').trim();
        if (!s || seen.has(s)) continue;
        if (/^(视频|直播|推荐|热门|动画|影视|首页|关注|消息|我|搜索|\d+(\.\d+)?[万亿]?|\d+:\d+)$/.test(s)) continue;
        if (/^(UP主|分区|标签|按钮|轻点|时长|弹幕|观看)/.test(s)) continue;
        seen.add(s); titles.push(s);
        if (titles.length >= 40) break;
      }
      if (screen < 5 && titles.length < 40) {
        await adbRun(['shell', 'input', 'swipe', '720', '2000', '720', '650', '700']);
        await sleep(1500);
      }
    }
    if (titles.length) log('模拟器推荐流标题 ' + titles.length + ' 条：' + titles.slice(0, 8).join(' | '));
    return titles;
  } catch (e) { log('模拟器推荐流读取失败：' + (e?.message ?? e)); return []; }
}
async function resolveFeedTitles(titles, limit) {
  const out = [];
  const used = new Set();
  for (const title of titles) {
    if (out.length >= limit) break;
    try {
      const sr = await fetch('https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(title.slice(0, 60)), { headers: { 'user-agent': UA, referer: 'https://search.bilibili.com/', ...(BILI_COOKIE ? { cookie: BILI_COOKIE } : {}) }, signal: AbortSignal.timeout(20000) });
      const j = await sr.json().catch(() => ({ code: -1 }));
      const list = j?.data?.result ?? [];
      log('模拟器标题搜索：' + title.slice(0, 18) + ' code=' + (j?.code ?? '?') + ' 结果=' + list.length + (j?.data ? '' : ' raw=' + String(j?.raw || '').slice(0, 80)));
      const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
      const exact = list.find((v) => clean(v.title) === title) || list.find((v) => clean(v.title).includes(title.slice(0, 18))) || list[0];
      if (!exact?.bvid || used.has(exact.bvid) || state.seenBvids.includes(exact.bvid)) continue;
      used.add(exact.bvid);
      out.push({ bvid: exact.bvid, aid: exact.aid, mid: exact.mid, title: clean(exact.title) || title, desc: clean(exact.description), author: exact.author, __interest: '模拟器推荐' });
    } catch (e) { log('模拟器标题搜索失败：' + (e?.message ?? e)); }
    await sleep(1500 + Math.floor(Math.random() * 1500));
  }
  return out;
}

function browseHourKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
}

function rememberBiliVideo({ bvid, title, author = '', duration = 0, interest, visual, activity, stat = {}, cover = '' }) {
  try {
    const at = Date.now();
    const rec = { bvid, title, author, duration, interest: interest || '', visual: visual || '', activity: activity || '', stat: { view: Number(stat?.view) || 0, reply: Number(stat?.reply) || 0, danmaku: Number(stat?.danmaku) || 0 }, cover, at };
    try { fs.appendFileSync(path.join(STATE_DIR, 'bili-watch-history.jsonl'), JSON.stringify(rec) + '\n', 'utf8'); } catch {}
    const file = path.join(STATE_DIR, 'bili-memory.json');
    const mem = readJson(file, { videos: [], preferences: {} });
    if (!Array.isArray(mem.videos)) mem.videos = [];
    mem.videos.push(rec);
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    mem.videos = mem.videos.filter((x) => Number(x?.at) >= cutoff).slice(-1000);
    writeJson(file, mem);
  } catch (e) { log('记录 B站记忆失败：' + (e?.message ?? e)); }
}

// ── B站 ───────────────────────────────────────────────────────────────────
function interestKeywords(name) {
  return String(name || '').split(/[\/、,，\s]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}
async function searchBiliVideos(keyword, limit = 12) {
  const key = String(keyword || '').slice(0, 60);
  const cacheFile = path.join(STATE_DIR, 'bili-search-cache.json');
  const cache = readJson(cacheFile, {});
  const now = Date.now();
  if (cache[key] && now - Number(cache[key].at || 0) < 24 * 60 * 60 * 1000) return cache[key].list || [];
  if (cache.__cooldownAt && now - Number(cache.__cooldownAt) < 10 * 60 * 1000) { log('B站搜索风控冷却中，改用推荐/排行补量'); return []; }
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(key), { headers: { 'user-agent': UA, referer: 'https://search.bilibili.com/', ...(BILI_COOKIE ? { cookie: BILI_COOKIE } : {}) }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (j?.code !== 0) {
      if (j?.code === -412 || j?.code === -509 || j?.code === -352) cache.__cooldownAt = now;
      log('B站搜索失败 code=' + (j?.code ?? '?') + ' ' + (j?.message || '') + '，改用推荐/排行补量');
      writeJson(cacheFile, cache);
      return [];
    }
    const list = (j?.data?.result || []).map((v) => ({ bvid: v.bvid, aid: v.aid, title: (v.title || '').replace(/<[^>]+>/g, ''), desc: v.description || v.desc || '', author: v.author || '', __interest: key })).filter((v) => v.bvid).slice(0, limit);
    cache[key] = { at: now, list };
    const keys = Object.keys(cache).filter((k) => k !== '__cooldownAt');
    if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete cache[k];
    writeJson(cacheFile, cache);
    return list;
  } catch (e) { log('B站搜索异常：' + (e?.message ?? e)); return []; }
}

async function followUp(mid) {
  if (!mid || !biliAuthCache.ok) return false;
  try {
    const c = readJson(COOKIE_FILE, {});
    const form = new URLSearchParams({ fid: String(mid), act: '1', re_src: '11', csrf: c.bili_jct });
    const r = await jsonFetch('https://api.bilibili.com/x/relation/modify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (r?.code === 0) { log('B站已关注 UP ' + mid); return true; }
    if (r?.code === -101) await markBiliAuthLost(r.code, r.message);
    return false;
  } catch { return false; }
}
async function collectVideo(aid) {
  if (!aid || !biliAuthCache.ok) return false;
  try {
    const c = readJson(COOKIE_FILE, {});
    const nav = await jsonFetch('https://api.bilibili.com/x/web-interface/nav');
    const mid = nav?.data?.mid;
    if (!mid) return false;
    const fl = await jsonFetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + mid);
    const folder = (fl?.data?.list || [])[0];
    if (!folder?.id) return false;
    const form = new URLSearchParams({ rid: String(aid), type: '2', add_media_ids: String(folder.id), del_media_ids: '', csrf: c.bili_jct });
    const r = await jsonFetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (r?.code === 0) { log('B站已收藏 ' + aid); return true; }
    if (r?.code === -101) await markBiliAuthLost(r.code, r.message);
    return false;
  } catch { return false; }
}
let biliSearchQuery = '';
function chooseBiliMode() {
  try {
    const social = readJson(path.join(STATE_DIR, 'social-v2.json'), { conversations: {} });
    const now = Date.now();
    const recent = Object.values(social.conversations || {}).flatMap((c) => (c.recentMessages || []).filter((m) => !m.isSelf && now - Number(m.time || 0) < 30 * 60 * 1000).map((m) => String(m.text || m.plain || ''))).slice(-20);
    const hit = recent.map((x) => /(?:搜一下|搜下|搜|查一下|查下|查|找一下|找)([^，。！？?]{2,20})/.exec(x)).find(Boolean);
    if (hit) { biliSearchQuery = String(hit[1] || '').trim(); if (biliSearchQuery) return 'search'; }
  } catch {}
  const r = Math.random();
  if (r < 0.5) return 'random';
  if (r < 0.75) return 'interest';
  if (r < 0.9) return 'hot';
  return 'interest';
}

function qualityCommentEligible(visual, title) {
  const v = String(visual || '').trim();
  if (v.length < 80) return false;
  if (/暂无|没看清|失败|只有字幕|无法判断/.test(v)) return false;
  if (!/画面|场景|人物|物体|动作|表情|镜头/.test(v)) return false;
  return Math.random() < 0.35;
}

const WBI_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
async function wbiMixin() {
  const nav = await jsonFetch('https://api.bilibili.com/x/web-interface/nav');
  const pick = (u) => String(u || '').split('/').pop()?.split('.')[0] || '';
  const raw = pick(nav?.data?.wbi_img?.img_url) + pick(nav?.data?.wbi_img?.sub_url);
  if (raw.length < 64) throw new Error('wbi key 获取失败');
  return WBI_TAB.map((i) => raw[i]).join('').slice(0, 32);
}
async function recommendationFeed(limit = 30) {
  const mixin = await wbiMixin();
  const params = { fresh_type: '3', ps: String(limit), wts: String(Math.floor(Date.now() / 1000)) };
  const query = Object.keys(params).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixin).digest('hex');
  const r = await fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + query + '&w_rid=' + w_rid, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(BILI_COOKIE ? { cookie: BILI_COOKIE } : {}) }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (j?.code !== 0) throw new Error('推荐流 code=' + (j?.code ?? '?') + ' ' + (j?.message || ''));
  return (j?.data?.item || []).filter((v) => v?.bvid).map((v) => ({ bvid: v.bvid, aid: v.id, mid: v.owner?.mid, title: String(v.title || ''), desc: String(v.desc || ''), author: String(v.owner?.name || ''), stat: v.stat || {}, pic: v.pic || '' }));
}
const statsCache = new Map();
async function statFor(v) {
  if (statsCache.has(v.bvid)) return statsCache.get(v.bvid);
  let st = v.stat || {};
  if (st.reply == null) {
    const j = await jsonFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(v.bvid)).catch(() => null);
    st = j?.data?.stat || st;
  }
  statsCache.set(v.bvid, st);
  return st;
}
function statOk(st) {
  return Number(st?.view) >= 100 && Number(st?.reply) >= 5 && Number(st?.danmaku) >= 5;
}
async function fetchImageBuffer(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('cover HTTP ' + r.status);
  return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: String(r.headers.get('content-type') || 'image/jpeg').split(';')[0] };
}
const coverCacheFile = path.join(STATE_DIR, 'bili-cover-semantics.json');
async function coverMatchesInterests(v, keywords) {
  try {
    if (!v?.pic || !keywords.length) return false;
    const cache = readJson(coverCacheFile, {});
    const hit = cache[v.bvid];
    if (hit && Date.now() - Number(hit.at || 0) < 30 * 24 * 60 * 60 * 1000) return hit.match === true;
    const img = await fetchImageBuffer(v.pic);
    if (img.buffer.length > 5 * 1024 * 1024) return false;
    const prompt = '判断这张 B 站视频封面与以下兴趣是否语义相关：' + keywords.join('、') + '。只输出 JSON：{"matches":["命中的兴趣"],"reason":"20字内"}。无关就 matches 为空。';
    const text = await describeVisuals({ images: [{ buffer: img.buffer, mimeType: img.mimeType }], cfg: fullCfg, prompt });
    const s = String(text || '');
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    let arr = [];
    if (a >= 0 && b > a) { try { arr = JSON.parse(s.slice(a, b + 1)).matches || []; } catch {} }
    const match = Array.isArray(arr) && arr.some((x) => keywords.some((k) => String(x).includes(k) || k.includes(String(x))));
    cache[v.bvid] = { at: Date.now(), match, matches: arr, reason: s.slice(0, 120) };
    const keys = Object.keys(cache); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete cache[k];
    writeJson(coverCacheFile, cache);
    return match;
  } catch (e) { log('封面语义判断失败 ' + (v?.bvid || '') + '：' + (e?.message ?? e)); return false; }
}
async function biliRound(slot) {
  const hour = browseHourKey();
  if (state.biliHourKey !== hour) { state.biliHourKey = hour; state.biliSelectedHour = 0; writeJson(STATE_FILE, state); }
  const target = Math.max(1, Number(conf.daily.biliPerHour) || Number(conf.daily.biliRead) || 10);
  const already = Number(state.biliSelectedHour) || 0;
  if (already >= target) { log('B站本小时已选够 ' + target + ' 条，等下一个整点'); return []; }
  const remaining = target - already;
  const interests = await ensureInterests({ stateDir: STATE_DIR, root: ROOT, fullCfg, log, today: today() });
  const keywords = interests.flatMap((x) => interestKeywords(x.name));
  const feed = await recommendationFeed(30).catch((e) => { log('B站推荐流失败：' + (e?.message ?? e)); return []; });
  if (!feed.length) { log('B站推荐流为空，本轮跳过'); return []; }
  const candidates = [];
  for (const v of feed) {
    if (!v.bvid || state.seenBvids.includes(v.bvid)) continue;
    const st = await statFor(v);
    if (!statOk(st)) { log('B站跳过（数据不达标）：' + v.bvid + ' 播放=' + (st?.view ?? '?') + ' 评论=' + (st?.reply ?? '?') + ' 弹幕=' + (st?.danmaku ?? '?')); continue; }
    candidates.push({ ...v, stat: st });
    if (candidates.length >= 24) break;
  }
  if (!candidates.length) { log('B站没有通过质量门槛的视频，本轮跳过'); return []; }
  const picked = [];
  const used = new Set();
  for (let i = 0; i < remaining && picked.length < remaining; i++) {
    const wantInterest = Math.random() < 0.6;
    let matched = candidates.filter((v) => !used.has(v.bvid) && keywords.some((k) => String(v.title || '').includes(k)));
    if (wantInterest && matched.length < 3) {
      let checked = 0;
      for (const v of candidates) {
        if (used.has(v.bvid) || matched.includes(v) || v.__coverChecked) continue;
        if (checked >= 8) break;
        v.__coverChecked = true; checked++;
        if (await coverMatchesInterests(v, keywords)) { v.__coverMatch = true; matched.push(v); }
      }
    }
    const pool = wantInterest && matched.length ? matched : candidates.filter((v) => !used.has(v.bvid));
    if (!pool.length) break;
    const v = pool[Math.floor(Math.random() * pool.length)];
    used.add(v.bvid);
    if (wantInterest && matched.length) v.__interest = v.__coverMatch ? '兴趣:封面语义' : ('兴趣:' + keywords.find((k) => String(v.title || '').includes(k)));
    else v.__interest = '随机推荐';
    picked.push(v);
  }
  log('B站本轮：推荐流 ' + candidates.length + ' 条达标，选中 ' + picked.length + ' 条（60%兴趣/40%随机）');
  if (!picked.length) return [];
  let biliAuth = await checkBiliAuth();
  await sleep(5000 + Math.floor(Math.random() * 55000));
  const out = [];
  let visualBudget = 2;
  for (const v of picked) {
    const title = String(v.title || '').slice(0, 80);
    const bvid = v.bvid;
    if (bvid && !state.seenBvids.includes(bvid)) { state.seenBvids.push(bvid); if (state.seenBvids.length > 300) state.seenBvids = state.seenBvids.slice(-300); }
    let comments = [];
    let visual = '';
    let activity = '';
    try {
      const detail = await summarizeBiliVideo({ root: ROOT, bvid, title, cfg: fullCfg, stateDir: STATE_DIR, log });
      if (detail) visual = String(detail).slice(0, 1600);
    } catch (e) { log('B站看视频失败 ' + bvid + '：' + (e?.message ?? e)); }
    if (conf.daily.biliTopComments > 0) {
      try {
        const cr = await jsonFetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + encodeURIComponent(v.aid) + '&sort=0&ps=5&pn=1');
        comments = (cr?.data?.replies || []).map((r) => ({ text: String(r?.content?.message || ''), rpid: String(r?.rpid || '') })).filter((r) => r.rpid && r.text);
      } catch {}
    }
    if (biliAuth.ok && visual && comments.length && qualityCommentEligible(visual, title) && canTopComment()) {
      const replyText = await genComment('B站视频', title + '\n' + visual + '\n热评：' + comments.slice(0, 2).map((c) => c.text).join(' / '));
      if (replyText && replyText.length >= 4) {
        try {
          const c = readJson(COOKIE_FILE, {});
          const form = new URLSearchParams({ oid: String(v.aid), type: '1', message: replyText, plat: '1', csrf: c.bili_jct });
          const r = await jsonFetch('https://api.bilibili.com/x/v2/reply/add', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          if (r?.code === 0) { noteTopComment(); activity = '💬 ' + replyText; }
          else if (r?.code === -101) biliAuth = await markBiliAuthLost(r.code, r.message);
        } catch {}
      }
    }
    if (biliAuth.ok && !activity && Math.random() < 0.35) {
      try {
        const form = new URLSearchParams({ bvid, like: '1', csrf: readJson(COOKIE_FILE, {}).bili_jct });
        const r = await jsonFetch('https://api.bilibili.com/x/v2/view/like', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
        if (r?.code === 0) { state.likes += 1; activity = '👍 点赞'; }
        else if (r?.code === -101) biliAuth = await markBiliAuthLost(r.code, r.message);
      } catch {}
    }
    rememberBiliVideo({ bvid, title, author: v.author || '', duration: Number(v.duration) || 0, interest: v.__interest || '', visual, activity, stat: v.stat || {}, cover: v.pic || '' });
    try { addPlatformItem({ platform: 'bilibili', itemId: bvid, title, summary: String(visual || '').slice(0, 800), occurredAt: Date.now(), meta: { interest: v.__interest || '', activity } }); } catch {}
    state.biliSelectedHour = (Number(state.biliSelectedHour) || 0) + 1;
    writeJson(STATE_FILE, state);
    out.push('- [B站] ' + title + '（' + bvid + '）\n  ' + (activity || '（只读）') + (comments.length ? '\n  热评：' + comments.slice(0, 2).map((c) => c.text).join(' / ').slice(0, 80) : ''));
  }
  return out;
}
// ── 微博 ──────────────────────────────────────────────────────────────────
async function weiboRound(slot) {
  const j = await jsonFetch('https://weibo.com/ajax/statuses/hot_band', { headers: { referer: 'https://weibo.com/' } });
  const bands = j?.data?.band_list ?? j?.data?.bandList ?? [];
  const words = bands.map((x) => x?.word ?? x?.note ?? x?.word_scheme ?? '').filter(Boolean).slice(0, Math.min(8, conf.daily.weiboRead));
  if (!words.length) { log(`微博热搜为空 code=${j?.code ?? '?'}`); return []; }
  return words.map((w) => `- [微博] ${w}`);
}

// ── 小红书（MCP HTTP）────────────────────────────────────────────────────
async function xhsCall(tool, args, session) {
  const r = await fetch('http://127.0.0.1:18060/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tool, arguments: args } }), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  const text = (j?.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  return { j, text, session: r.headers.get('mcp-session-id') };
}

async function xhsRound(slot) {
  try {
    const init = await fetch('http://127.0.0.1:18060/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'browse', version: '1' } } }) });
    const sid = init.headers.get('mcp-session-id');
    const login = await xhsCall('check_login_status', {}, sid);
    if (!/已登录|login|true|成功/i.test(login.text) || /失败|error|内部错误/i.test(login.text)) {
      log(`小红书跳过：${login.text.slice(0, 80)}`);
      return [];
    }
    const kw = (conf.daily.xhsKeywords ?? [])[Math.floor(Math.random() * (conf.daily.xhsKeywords?.length || 1))] ?? '日常';
    const search = await xhsCall('search_feeds', { keyword: kw }, sid);
    const ids = [...search.text.matchAll(/"id"\s*:\s*"([0-9a-f]{20,})"/g)].map((m) => m[1]).slice(0, 3);
    const out = [];
    for (const id of ids) {
      const detail = await xhsCall('get_feed_detail', { feed_id: id, xsec_token: '' }, sid).catch(() => ({ text: '' }));
      const title = (detail.text.match(/"title"\s*:\s*"([^"]{2,60})"/) ?? [])[1] ?? id;
      out.push(`- [小红书] ${title}`);
    }
    return out;
  } catch (e) {
    log(`小红书不可用：${e?.message ?? e}`);
    return [];
  }
}

// ── 一轮 ──────────────────────────────────────────────────────────────────
async function runSlot(slot) {
  if (state.doneSlots.includes(slot)) return;
  const hour = browseHourKey();
  if (state.biliHourKey !== hour) { state.biliHourKey = hour; state.biliSelectedHour = 0; writeJson(STATE_FILE, state); }
  const biliTarget = Math.max(1, Number(conf.daily.biliPerHour) || Number(conf.daily.biliRead) || 10);
  if (Number(state.biliSelectedHour) >= biliTarget) { log('B站本小时已选够 ' + biliTarget + ' 条，等下一个整点'); return; }
  log(`开始刷：${slot}（dryRun=${conf.dryRun}）`);
  await sleep(Math.floor(Math.random() * 90000)); // 真人不会准点整分出现
  const lines = [];
  try { lines.push(...(await biliRound(slot))); } catch (e) { log('B站失败：' + (e?.message ?? e) + '\n' + String(e?.stack ?? '').slice(0, 800)); }
  if (!conf.biliOnly && !process.argv.includes('--bili-only')) {
    try { lines.push(...(await weiboRound(slot))); } catch (e) { log('微博失败：' + (e?.message ?? e)); }
    try { lines.push(...(await xhsRound(slot))); } catch (e) { log('小红书失败：' + (e?.message ?? e)); }
  }
  if (lines.length) appendNote(slot, lines);
  state.doneSlots.push(slot);
  writeJson(STATE_FILE, state);
  log(`完成 ${slot}：${lines.length} 条`);
}

function dueSlots(now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  return (conf.slots ?? []).filter((s) => {
    if ((state.doneSlots ?? []).includes(s)) return false;
    const [h, m] = String(s).split(':').map(Number);
    const slotMin = h * 60 + m;
    // 只在时点后 15 分钟内触发，避免启动时把过去所有时段一次性补跑
    return mins >= slotMin && mins - slotMin <= 25;
  });
}

const forceNow = process.argv.includes('--now');
if (process.argv.includes('--dry-run')) conf.dryRun = true;
if (forceNow) {
  await runSlot(`手动-${new Date().toTimeString().slice(0, 5)}`);
  process.exit(0);
}

log(`browse 启动：时段 ${(conf.slots ?? []).join(', ')}；dryRun=${conf.dryRun}`);
let slotRunning = false;
setInterval(async () => {
  if (slotRunning) return;
  slotRunning = true;
  try {
    if (state.date !== today()) { state = { date: today(), doneSlots: [], comments: {}, likes: 0, lastCommentAt: 0, biliSelectedHour: 0, biliHourKey: '', seenBvids: [] }; writeJson(STATE_FILE, state); }
    for (const slot of dueSlots()) await runSlot(slot);
  } finally { slotRunning = false; }
}, 60000);
