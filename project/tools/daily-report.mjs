// 每日日报：她今天干了什么、花了多少、服务稳不稳。
//
// 数据：life.log / token-usage.jsonl / qq-activity.log / bridge.log / keepalive.log / 端口 / 磁盘 / 今天动过的文件
// 产物：agent-home\notes\daily\YYYY-MM-DD.md（详细版）+ 一条 QQ 私聊（精简版）
//
// 用法：node tools\daily-report.mjs [--no-send] [--date 2026-10-22]
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const HOME = path.join(ROOT, 'agent-home');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const noSend = !process.argv.includes('--send'); // 默认只写文件：日报是给她自己看的

const now0 = new Date();
const localDay = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, '0')}-${String(now0.getDate()).padStart(2, '0')}`;
const day = String(arg('date', localDay)); // YYYY-MM-DD（本地日期）
const todayPrefix = `[${day.replace(/-/g, '/')}`; // life.log 用 2026/10/22
const startMs = new Date(`${day}T00:00:00`).getTime();
const endMs = startMs + 86400000;

const readLines = (p) => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/); } catch { return []; } };
const lines = (p) => readLines(p).filter(Boolean);

// ── 心跳 ────────────────────────────────────────────────────────────────────
const life = lines(path.join(STATE, 'life.log')).filter((l) => l.startsWith(todayPrefix));
const ticks = life.map((l) => {
  const m = l.match(/第 (\d+) 次心跳：(\w+)，(\d+)s，输出 (\d+) 字(?:：(.*))?$/);
  return m ? { n: +m[1], kind: m[2], secs: +m[3], chars: +m[4], text: (m[5] ?? '').trim(), time: l.slice(1, 20) } : null;
}).filter(Boolean);
const idle = ticks.filter((t) => t.chars <= 6).length;
const productive = ticks.length - idle;
const tickTimes = ticks.map((t) => Date.parse(String(t.time).replace(/\//g, '-'))).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
const maxGapMin = tickTimes.length > 1 ? Math.round(Math.max(0, ...tickTimes.slice(1).map((x, i) => (x - tickTimes[i]) / 60000))) : 0;

// ── token ───────────────────────────────────────────────────────────────────
let turns = 0, cacheMiss = 0, cacheHit = 0, output = 0;
for (const l of lines(path.join(STATE, 'token-usage.jsonl'))) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (!(j.t >= startMs && j.t < endMs)) continue;
  turns++;
  cacheMiss += j.b?.cacheMiss ?? 0;
  cacheHit += j.b?.cacheHit ?? 0;
  output += (j.b?.output ?? 0) + (j.b?.reasoning ?? 0);
}

// ── QQ ──────────────────────────────────────────────────────────────────────
// 2026-10-27 改：原来只读 qq-activity.log。日志会在白天轮转（今天 23:07 转的），
// 轮转后当天的数据一半在 .log.1 里，导致 "QQ 收到 N 条" 只统计到轮转后那一段
// （今天报'收到 10 条，覆盖约 36 分钟'，实际全天远不止）。
// 改法：两个文件都读，按行内时间戳去重后合并。
// 行自带日期时按 day 过滤；无日期旧行只认当前文件（和 bridge 报错的口径一致）。
const actAll = [
  ...lines(path.join(STATE, 'qq-activity.log')),
  ...lines(path.join(STATE, 'qq-activity.log.1')).filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l) || /^\[\d{4}-\d{2}-\d{2}/.test(l)),
];
const act = actAll.filter((l) => {
  const m = l.match(/^\[(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}):(\d{2}):(\d{2})\]/);
  if (!m) return false;
  return m[1] ? m[1] === day : true;
});
// 覆盖窗口只算"当天的行"（act 已按 day 过滤）。原来用 actAll，会把明天的行也算进来——
// 10-27 那天因此报出"覆盖 836 分钟"（因为 .log 里已经有 10-28 08:00 的行）。
const actTimes = act.map((l) => l.match(/^\[(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}):(\d{2}):(\d{2})\]/)).filter(Boolean).map((m) => m[1] ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : `${day} ${m[2]}:${m[3]}:${m[4]}`);
// 两个文件拼起来后时间不连续（当前文件在前、.1 在后），所以取最小/最大，不能取首尾。
const actMs = actTimes.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
const qqWindowMin = actMs.length >= 2 ? Math.max(0, Math.round((Math.max(...actMs) - Math.min(...actMs)) / 60000)) : 0;
const incoming = act.filter((l) => l.includes('消息已入未读')).length;
const voiceOut = act.filter((l) => l.includes('[voice]')).length;
const stickerOut = act.filter((l) => l.includes('[sticker]')).length;

// ── 健康 ────────────────────────────────────────────────────────────────────
const bridgeFiles = [path.join(STATE, 'bridge.log'), path.join(STATE, 'bridge.log.1')].filter((f) => fs.existsSync(f));
let bridgeErrors = 0;
let undatedBridgeErrors = 0;
for (const f of bridgeFiles) {
  const fileLines = lines(f);
  const hasDated = fileLines.some((l) => /^\d{4}-\d{2}-\d{2}[ T]/.test(l));
  for (const l of fileLines) {
    if (!/错误|失败/.test(l)) continue;
    if (/SnowLuma WebSocket closed|DSH 不可用|已入队等待|重试/.test(l)) continue;
    const m = l.match(/^(?:(\d{4}-\d{2}-\d{2})[ T])|(\d{4}-\d{2}-\d{2})[ T]/);
    if (m) { if ((m[1] || m[2]) === day) bridgeErrors += 1; continue; }
    // 过渡期：文件里一旦有带日期的新行，旧的无日期行一律不计入当天，单独统计。
    if (hasDated) { undatedBridgeErrors += 1; continue; }
    if (f.endsWith('bridge.log')) bridgeErrors += 1;
  }
}
const restarts = lines(path.join(ROOT, 'tools', 'keepalive.log')).filter((l) => l.includes(day) && /\brestart\b/.test(l)).length;
const ports = [3080, 3100, 5099, 3001, 18060, 11435];
const portOpen = (port) => new Promise((resolve) => {
  const s = new net.Socket();
  s.setTimeout(600);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(false));
  s.connect(port, '127.0.0.1');
});
const up = [];
for (const p of ports) up.push({ port: p, ok: await portOpen(p) });
const down = up.filter((u) => !u.ok).map((u) => u.port);

let diskFree = '';
try { const st = fs.statfsSync(ROOT); diskFree = `${(st.bavail * st.bsize / 1e9).toFixed(0)} GB`; } catch {}

// ── 今天动过的文件 ──────────────────────────────────────────────────────────
const touched = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { const st = fs.statSync(p); if (st.mtimeMs >= startMs && st.mtimeMs < endMs) touched.push({ rel: path.relative(ROOT, p), kb: Math.round(st.size / 1024) }); }
  }
})(HOME);

// ── 组装 ────────────────────────────────────────────────────────────────────
const mmhh = (t) => t.time.slice(11, 16);
const highlights = ticks.filter((t) => t.chars > 6).slice(-3).map((t) => `· ${mmhh(t)} ${t.text.replace(/\s+/g, ' ').slice(0, 90)}`);

const report = [
  `# ${day} 日报`,
  '',
  `- 心跳：${ticks.length} 次（有产出 ${productive}，IDLE ${idle}；最长空档 ${maxGapMin} 分钟）`,
  `- 模型调用：${turns} 轮，输入 ${(cacheMiss + cacheHit).toLocaleString()} tok（缓存命中 ${cacheHit.toLocaleString()}），输出 ${output.toLocaleString()} tok`,
  `- QQ：收到 ${incoming} 条（日志覆盖约 ${qqWindowMin} 分钟），发出语音 ${voiceOut} 条、表情 ${stickerOut} 条`,
  `- 服务：${down.length ? `⚠️ 挂了 ${down.join(', ')}` : '正常'}；今天被看门狗重启 ${restarts} 次；bridge 报错 ${bridgeErrors} 行${undatedBridgeErrors ? `（另有 ${undatedBridgeErrors} 条无日期旧行未计入）` : ''}`,
  diskFree ? `- 磁盘剩余：${diskFree}` : '',
  '',
  '## 今天做了什么',
  ...(highlights.length ? highlights : ['（没有产出，整天空转）']),
  '',
  '## 动过的文件',
  ...(touched.length ? touched.map((t) => `- ${t.rel}（${t.kb} KB）`) : ['（无）']),
  '',
].filter((x) => x !== undefined).join('\n');

const outDir = path.join(HOME, 'notes', 'daily');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${day}.md`);
fs.writeFileSync(outFile, `${report}\n`, 'utf8');
console.log(report);
console.log(`\n[written] ${outFile}`);

if (noSend) process.exit(0);

// ── 发 QQ（直连 OneBot，和 send-qq.mjs 同一条路）──────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const base = (cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken ?? '';
const owner = cfg.ownerQQ;
const short = [
  `📋 ${day} 日报`,
  `心跳 ${ticks.length} 次（有产出 ${productive} / IDLE ${idle}；最长空档 ${maxGapMin} 分钟）`,
  `模型 ${turns} 轮，输入 ${(cacheMiss + cacheHit).toLocaleString()} tok（缓存 ${cacheHit.toLocaleString()}），输出 ${output.toLocaleString()} tok`,
  `QQ 收 ${incoming} 条 / 语音 ${voiceOut} / 表情 ${stickerOut}`,
  down.length ? `⚠️ 服务挂了 ${down.join(', ')}` : `✅ 服务正常${restarts ? `（重启 ${restarts} 次）` : ''}`,
  highlights.length ? `今天：${highlights.map((h) => h.replace(/^· \d{2}:\d{2} /, '')).join('；').slice(0, 160)}` : '',
  `详情：agent-home\\notes\\daily\\${day}.md`,
].filter(Boolean).join('\n');

// 统一出口（F03）：走桥接 /api/outbound/notify；拒绝/不可用即失败，不回退直连。
const consoleToken = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'state', 'console-token'), 'utf8').trim();
const res = await fetch('http://127.0.0.1:3100/api/outbound/notify', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
  body: JSON.stringify({ key: 'private:' + owner, text: short, exempt: false, record: true }),
  signal: AbortSignal.timeout(15000),
});
const j = await res.json().catch(() => ({}));
if (j.ok) console.log('[sent] message_id=' + (j.messageId ?? '?'));
else { console.error('[send failed]', JSON.stringify(j).slice(0, 300)); process.exit(1); }
