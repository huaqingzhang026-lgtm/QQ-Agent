// B 站链接解析：b23.tv 短链 → BV 号 → 视频信息。
// 解决“分享卡片只有短链、模型打不开”的问题；不依赖 WBI search。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { transcribeAudio } from '../qq-bridge/src/asr.js';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

function cookieHeader(root) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, 'bili-mcp', 'cookie.json'), 'utf8'));
    if (c.full_cookie) return String(c.full_cookie);
    if (!c.sessdata) return '';
    return `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct ?? ''}; DedeUserID=${c.dede_user_id ?? ''}`;
  } catch { return ''; }
}

export function findBiliLink(text) {
  const s = String(text ?? '');
  const short = s.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/i)?.[0];
  if (short) return { type: 'short', url: short };
  const bv = s.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i)?.[1] || s.match(/(?<![0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/)?.[1];
  if (bv) return { type: 'bvid', bvid: bv };
  const av = s.match(/bilibili\.com\/video\/av(\d+)/i)?.[1];
  if (av) return { type: 'aid', aid: av };
  return null;
}

async function resolveShort(url, cookie) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA_MOBILE, ...(cookie ? { cookie } : {}), referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(15000),
  });
  const html = await r.text();
  const fromUrl = String(r.url || '').match(/(BV[0-9A-Za-z]{10})/)?.[1];
  const fromHtml = html.match(/(BV[0-9A-Za-z]{10})/)?.[1];
  return fromUrl || fromHtml || '';
}

export async function resolveBiliLink(text, { root = process.cwd() } = {}) {
  const found = findBiliLink(text);
  if (!found) return null;
  const cookie = cookieHeader(root);
  let bvid = found.bvid || '';
  let aid = found.aid || '';
  if (found.type === 'short') bvid = await resolveShort(found.url, cookie);
  if (!bvid && !aid) return { ok: false, reason: '短链没有解析出 BV 号', link: found.url };

  const api = aid && !bvid
    ? `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid)}`
    : `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const r = await fetch(api, { headers: { 'user-agent': UA_DESKTOP, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  const d = j?.data;
  if (!d) return { ok: false, bvid, reason: j?.message || '视频信息获取失败', link: found.url };
  let subtitle = '';
  let comments = [];
  try {
    const pr = await fetch(`https://api.bilibili.com/x/player/v2?aid=${d.aid}&cid=${d.cid}`, { headers: { 'user-agent': UA_DESKTOP, referer: `https://www.bilibili.com/video/${d.bvid || bvid}`, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(15000) });
    const pj = await pr.json().catch(() => null);
    const sub = pj?.data?.subtitle?.subtitles?.[0];
    if (sub?.subtitle_url) {
      const sr = await fetch(sub.subtitle_url, { headers: { 'user-agent': UA_DESKTOP, referer: `https://www.bilibili.com/video/${d.bvid || bvid}` }, signal: AbortSignal.timeout(15000) });
      const sj = await sr.json().catch(() => null);
      subtitle = (sj?.body ?? []).map((x) => String(x?.content ?? '')).join(' ').slice(0, 4000);
    }
  } catch {}
  try {
    const cr = await fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${d.aid}&sort=2&ps=6&pn=1`, { headers: { 'user-agent': UA_DESKTOP, referer: `https://www.bilibili.com/video/${d.bvid || bvid}`, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(15000) });
    const cj = await cr.json().catch(() => null);
    comments = (cj?.data?.replies ?? []).map((r) => String(r?.content?.message ?? '').trim()).filter(Boolean).slice(0, 6);
  } catch {}
  return {
    ok: true,
    badge: d.tname || '',
    subtitle,
    comments,
    bvid: d.bvid || bvid,
    aid: d.aid,
    cid: d.cid,
    title: String(d.title ?? ''),
    desc: String(d.desc ?? '').slice(0, 600),
    owner: String(d.owner?.name ?? ''),
    duration: Number(d.duration) || 0,
    url: `https://www.bilibili.com/video/${d.bvid || bvid}`,
  };
}

export async function transcribeBiliAudio({ root = process.cwd(), bvid, cid, aid, cfg, log = () => {} } = {}) {
  if (!bvid || !cid || !aid) return '';
  const cookie = cookieHeader(root);
  const referer = `https://www.bilibili.com/video/${bvid}`;
  try {
    const pr = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=16`, { headers: { 'user-agent': UA_DESKTOP, referer, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(20000) });
    const pj = await pr.json().catch(() => null);
    const audio = (pj?.data?.dash?.audio ?? []).slice().sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0))[0];
    if (!audio?.baseUrl) return '';
    const ar = await fetch(audio.baseUrl, { headers: { 'user-agent': UA_DESKTOP, referer, ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(60000) });
    if (!ar.ok) return '';
    const abuf = Buffer.from(await ar.arrayBuffer());
    if (!abuf.length || abuf.length > 20 * 1024 * 1024) return '';
    const ff = cfg?.socialV2?.voice?.ffmpegPath;
    if (!ff) return '';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-asr-'));
    const seg = spawnSync(ff, ['-y', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'segment', '-segment_time', '120', '-reset_timestamps', '1', path.join(dir, '%03d.mp3')], { input: abuf, maxBuffer: 16 * 1024 * 1024, timeout: 180000, windowsHide: true });
    if (seg.status !== 0) return '';
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort().slice(0, 6);
    const parts = [];
    for (const f of files) {
      const mp3 = fs.readFileSync(path.join(dir, f));
      const text = String(await transcribeAudio({ buffer: mp3, cfg }) || '').trim();
      if (text) parts.push(text);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    const text = parts.join(' ').slice(0, 3000);
    if (isLikelyMusicTranscript(text)) { log('[bili] 语音像纯音乐/无语音，忽略 ASR：' + bvid); return ''; }
    if (text) log('[bili] 语音转写 ' + text.length + ' 字：' + bvid);
    return text;
  } catch { return ''; }
}

export function formatBiliInfo(info) {
  if (!info?.ok) return info?.reason ? `【B站链接解析失败】${info.reason}` : '';
  return `【B站视频信息】${info.title}\nUP：${info.owner}｜分区：${info.badge || '未知'}｜时长：${Math.floor(info.duration / 60)}分${info.duration % 60}秒｜${info.bvid}\n简介：${info.desc || '（无）'}${info.comments?.length ? '\n热评：' + info.comments.slice(0, 4).join(' / ') : ''}${info.subtitle ? '\n字幕：' + info.subtitle.slice(0, 800) : ''}`;
}

if (process.argv[1] && process.argv[1].endsWith('bili-link.mjs')) {
  const text = process.argv.slice(2).join(' ');
  resolveBiliLink(text).then((info) => {
    console.log(JSON.stringify(info, null, 2));
    console.log(formatBiliInfo(info));
  }).catch((e) => { console.error(e); process.exit(1); });
}

/** 纯音乐/无语音时 ASR 常吐“哒哒哒”“啦啦啦”；这类结果不要喂给主模型。 */
export function isLikelyMusicTranscript(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  const chars = [...t.replace(/[^\u4e00-\u9fa5]/g, '')];
  const uniq = new Set(chars).size;
  if (chars.length >= 20 && uniq <= 6 && /[哒啦啊哈嘿哦嗯呀喔噢]/.test(t)) return true;
  if (/(哒|啦|哈|嘿){8,}/.test(t)) return true;
  return false;
}
