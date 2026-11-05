// 错误观察器：扫描 bridge.log，发现新错误后唤醒主人私聊的自动修复流程。
// 只负责发现与去重；实际修复由 DSH 会话在 self-fix 授权下用 ops 工具完成。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const LOG = path.join(STATE, 'bridge.log');
const OUT = path.join(STATE, 'self-fix-watch.log');
const STATE_FILE = path.join(STATE, 'self-fix-watch.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(OUT, line + '\n', 'utf8'); } catch {} };
const DAY = 24 * 3600 * 1000;

const st = readJson(STATE_FILE, { offset: 0, seen: {}, lastWakeAt: 0, day: '', dayCount: 0 });
let text = '';
try { text = fs.readFileSync(LOG, 'utf8'); } catch { process.exit(0); }
if (text.length < Number(st.offset || 0)) st.offset = 0;
const fresh = text.slice(Number(st.offset || 0));
st.offset = text.length;
const now = Date.now();
const day = new Date(now).toISOString().slice(0, 10);
if (st.day !== day) { st.day = day; st.dayCount = 0; }
const skip = /SnowLuma 错误：TypeError|连接断开|重连中|自愈|config\.json 端点已是最新|已连接|桥接已启动|连接 DSH 事件流|本地控制台|机器人昵称|sticker|已安排主动机会|桥接模式已确定|style|群风格|活跃度|persona\] 当前人格版本/;
const candidates = fresh.split('\n').filter((line) => {
  if (!line.trim() || skip.test(line)) return false;
  return /(⚠️|TypeError|SyntaxError|ReferenceError|ECONN|ETIMEDOUT|EADDR|Connection error|不可用|处理出错|失败|错误|超时|崩溃)/.test(line);
});
if (!candidates.length) { writeJson(STATE_FILE, st); process.exit(0); }

const sigOf = (line) => crypto.createHash('sha1').update(String(line).replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/, '').replace(/\d{5,}/g, '#')).digest('hex').slice(0, 14);
const picked = [];
for (const line of candidates.slice(-5)) {
  const sig = sigOf(line);
  const seen = st.seen?.[sig];
  if (seen && now - Number(seen.at || 0) < 30 * 60 * 1000) continue;
  st.seen = st.seen || {}; st.seen[sig] = { at: now, line: line.slice(0, 300) };
  picked.push({ sig, line: line.slice(0, 800) });
}
if (!picked.length) { writeJson(STATE_FILE, st); log('新错误均处于 30 分钟去重窗口'); process.exit(0); }
if (st.dayCount >= 3) { writeJson(STATE_FILE, st); log('今日自动修复唤醒已达 3 次，跳过'); process.exit(0); }
if (now - Number(st.lastWakeAt || 0) < 30 * 60 * 1000) { writeJson(STATE_FILE, st); log('自动修复冷却中，跳过'); process.exit(0); }

const token = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();
const body = picked.map((x) => x.line).join('\n').slice(0, 1800);
try {
  const r = await fetch('http://127.0.0.1:3100/api/self-fix/wake', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) }, body: JSON.stringify({ text: body, signature: picked.map((x) => x.sig).join(',') }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok !== true) throw new Error(j.error || 'HTTP ' + r.status);
  st.lastWakeAt = now; st.dayCount += 1;
  log(`已唤醒自动修复：${picked.map((x) => x.sig).join(',')}`);
} catch (e) { log('唤醒自动修复失败：' + (e?.message ?? e)); }
writeJson(STATE_FILE, st);
