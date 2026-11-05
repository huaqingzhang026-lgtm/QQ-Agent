// 看示例主播直播：开播时进直播间打个招呼，看的中间随机发几句弹幕（哈哈哈/好听）。
// 走 bili-mcp 的 bilibili_live_danmaku（带白名单 + 20 条/天 + 15 秒间隔的闸门）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const CONF = path.join(STATE, 'live-guest.json');
const LIVE = path.join(STATE, 'live-watch.json');
const LOG = path.join(ROOT, 'tools', 'live-guest.log');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const log = (m) => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };

const fullCfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const conf = readJson(CONF, {
  uid: 30001,
  roomId: 40001,
  perRunChatProbability: 0.12,
  minChatGapMin: 20,
  greetedFor: 0,
  lastChatAt: 0,
  chats: ['哈哈哈哈', '好听好听', '好听', '笑死'],
});
if (!fs.existsSync(CONF)) fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');

let info;
try {
  const r = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${conf.roomId}`, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://live.bilibili.com/' },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`code ${j.code}`);
  info = j.data;
} catch (e) {
  log(`拉直播间状态失败：${e.message}`);
  process.exit(0);
}

if (Number(info?.live_status) !== 1) { log('没在播，跳过'); process.exit(0); }

// ── 从直播间学弹幕：正在播的时候，抓最近的弹幕，留下高频短句 ──────────────
try {
  const r = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${conf.roomId}`, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: `https://live.bilibili.com/${conf.roomId}` },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  const list = (j.data?.room ?? []).map((m) => String(m.text ?? '').trim()).filter(Boolean);
  const AD = /(加群|微信|QQ群|代练|代打|私聊|粉丝牌|互关|求关注|链接|http|ww{2,}|[0-9]{5,})/i;
  const counts = new Map();
  for (const s of list) {
    if (s.length < 2 || s.length > 12) continue;
    if (/^[@\[]/.test(s)) continue;
    if (AD.test(s)) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (counts.size) {
    const learned = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([s]) => s);
    const merged = [...new Set([...learned, ...(conf.chats ?? [])])].slice(0, 60);
    conf.chats = merged;
    fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');
    log(`直播间弹幕学到 ${learned.length} 条（样本 ${list.length} 条）`);
  }
} catch (e) { log('学弹幕失败：' + e.message); }

const live = readJson(LIVE, {});
const liveStartAt = Number(live.lastLiveAt ?? 0);
const now = Date.now();
const hour = new Date().getHours();
const greeting = hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好';

async function genGuestText() {
  try {
    const v = fullCfg.socialV2?.vision ?? {};
    const key = fullCfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
    if (!key) return '';
    const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
    const prompt = '你在 B站主播「' + String(conf.name || '示例主播') + '」的直播间，账号 Pluto。主播标题：' + String(info?.title || '') + '。最近直播间弹幕：' + (conf.chats || []).slice(-8).join(' / ') + '。写一条弹幕：必须接一个具体的梗/内容/主播的话，不要空泛夸“好听/哈哈”；如果找不到具体点，只输出 [SKIP]。不超过 20 字，不要引号、不要解释。';
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 80, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    const out = String(j?.choices?.[0]?.message?.content || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
    if (!out || /^\[SKIP\]$/i.test(out)) return '';
    return out.slice(0, 30);
  } catch { return ''; }
}

let text = '';
if (Number(conf.greetedFor) !== liveStartAt) {
  text = greeting;
  conf.greetedFor = liveStartAt;
} else if (now - Number(conf.lastChatAt ?? 0) > Number(conf.minChatGapMin) * 60000 && Math.random() < Number(conf.perRunChatProbability)) {
  text = await genGuestText();
  if (!text) log('没有具体反应点，这次不发');
}

if (!text) { log(`在播，但这次不发（上次 ${Math.round((now - Number(conf.lastChatAt ?? 0)) / 60000)} 分钟前）`); process.exit(0); }

// 通过 bili MCP 发直播弹幕（走白名单与配额）
const NODE = process.execPath;
const child = spawn(NODE, [path.join(ROOT, 'bili-mcp', 'run.mjs')], { cwd: path.join(ROOT, 'bili-mcp'), stdio: ['pipe', 'pipe', 'ignore'] });
const rl = readline.createInterface({ input: child.stdout });
let done = false;
const finish = (ok, detail) => {
  if (done) return;
  done = true;
  try { child.kill(); } catch {}
  if (ok) {
    conf.lastChatAt = now;
    fs.writeFileSync(CONF, JSON.stringify(conf, null, 2) + '\n', 'utf8');
    log(`已发弹幕：${text}（${detail}）`);
  } else {
    log(`发弹幕失败：${text} → ${detail}`);
  }
  process.exit(0);
};
const timer = setTimeout(() => finish(false, '超时'), 45000);
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === 1) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bilibili_live_danmaku', arguments: { uid: conf.uid, message: text } } }) + '\n');
  } else if (m.id === 2) {
    clearTimeout(timer);
    const out = (m.result?.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 160);
    finish(!m.result?.isError, out);
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-guest', version: '1' } } }) + '\n');
