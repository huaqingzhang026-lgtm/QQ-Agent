// B 站登录态巡检：失效时通过桥接私聊通知主人；不自动扫码，避免拿不到手机确认。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const COOKIE = path.join(ROOT, 'bili-mcp', 'cookie.json');
const STATE_FILE = path.join(STATE, 'bili-login-watch.json');
const LOG = path.join(STATE, 'bili-login-watch.log');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };

const cfg = read(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const c = read(COOKIE, {});
const cookie = c.full_cookie || [`SESSDATA=${c.sessdata || ''}`, `bili_jct=${c.bili_jct || ''}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : ''].filter(Boolean).join('; ');
try {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  const ok = j?.code === 0 && j?.data?.isLogin === true;
  if (ok) { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCheckAt: Date.now(), ok: true, at: new Date().toISOString() }, null, 2) + '\n', 'utf8'); log('登录正常：' + (j.data.uname || '')); process.exit(0); }
  const old = read(STATE_FILE, {});
  if (Date.now() - Number(old.lastNotifyAt || 0) < 30 * 60 * 1000) { log('登录失效，但 30 分钟内已通知，跳过'); process.exit(0); }
  const token = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();
  const text = `⚠️ B站登录态失效：${j?.message || ('code=' + (j?.code ?? '?'))}\n请在电脑上运行：node bili-mcp/qr-login.mjs，然后用手机 B 站扫码；登录后会继续自动浏览和评论。`;
  await fetch('http://127.0.0.1:3100/api/outbound/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
    body: JSON.stringify({ key: 'private:' + String(cfg.ownerQQ || ''), text, exempt: true, record: true }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastNotifyAt: Date.now(), reason: j?.message || String(j?.code || ''), at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  log('已通知主人 B站登录失效');
} catch (e) {
  log('巡检异常：' + (e?.message ?? e));
  process.exitCode = 1;
}
