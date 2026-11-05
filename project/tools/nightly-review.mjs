// 每晚 00:05 复盘：回看"昨天"她说过的话，能自修的写修正笔记，不能的 QQ 通知主人。
//
// 数据：qq-bridge/state/social-v2.json（她自己的 recentMessages）+ bridge.log 错误行
// 产出：agent-home/notes/reviews/<date>.md（+ 修正笔记）
// 通知：走桥接 /api/outbound/notify（私聊 ownerQQ）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { reviewWindow, collectSelfMessages, decideNotify, summarizeIssues } from '../qq-bridge/src/review-lib.js';
import { notifyViaBridge } from './lib/bridge-notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'qq-bridge', 'state');
const SOCIAL = path.join(STATE_DIR, 'social-v2.json');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
const REVIEWS = path.join(ROOT, 'agent-home', 'notes', 'reviews');
const STATE_FILE = path.join(STATE_DIR, 'review-state.json');
const PID_FILE = path.join(STATE_DIR, 'nightly-review.pid');
const LOG_FILE = path.join(STATE_DIR, 'nightly-review.log');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {} };

const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const rc = { enabled: true, hour: 0, minute: 5, maxMessages: 200, ownerQQ: String(cfg.ownerQQ ?? ''), notify: true, ...(cfg.socialV2?.review ?? {}) };
if (rc.enabled === false) { log('review 未启用，退出'); process.exit(0); }

try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
process.on('exit', () => { try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {} });

let state = readJson(STATE_FILE, { lastDate: '' });

async function callModel(prompt) {
  const v = cfg.socialV2?.vision ?? {};
  const key = cfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 1200, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => null);
    return String(j?.choices?.[0]?.message?.content ?? '').trim();
  } catch { return ''; }
}

function parseJson(text) {
  const raw = String(text ?? '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
}

function errorLines({ start, end }) {
  try {
    const lines = fs.readFileSync(BRIDGE_LOG, 'utf8').split('\n');
    const out = [];
    for (const line of lines) {
      const m = line.match(/^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2}:\d{2}).*(失败|错误|error|Error|异常)/);
      if (!m) continue;
      let ts;
      if (m[1]) { ts = Date.parse(`${m[1]}T${m[2]}`); }
      else {
        const [h, mi, sec] = m[2].split(':').map(Number);
        const d = new Date(start);
        d.setHours(h, mi, sec, 0);
        ts = d.getTime();
        if (ts < start) ts += 86400000;
      }
      if (ts >= start && ts < end) out.push(line.slice(0, 160));
    }
    return out.slice(-30);
  } catch { return []; }
}

async function notifyOwner(text) {
  if (rc.notify === false || !rc.ownerQQ) return { ok: false, error: 'disabled' };
  return notifyViaBridge({ key: `private:${rc.ownerQQ}`, text: String(text).slice(0, 600), exempt: false, timeoutMs: 20000 });
}

function windowFor(dateStr) {
  if (!dateStr) return reviewWindow(Date.now());
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { date: dateStr, start, end: start + 86400000 };
}

async function runReview(date, windowOverride = null) {
  const window = windowOverride ?? reviewWindow(Date.now());
  if (window.date !== date) return;
  const social = readJson(SOCIAL, {});
  const mine = collectSelfMessages(social.conversations ?? {}, { start: window.start, end: window.end, max: rc.maxMessages });
  const errors = errorLines(window);
  if (!mine.length) {
    const md = `# 复盘 ${date}\n\n今天她没怎么说话（0 条），没什么可复盘的。\n`;
    fs.mkdirSync(REVIEWS, { recursive: true });
    fs.writeFileSync(path.join(REVIEWS, `${date}.md`), md, 'utf8');
    log(`${date} 无发言，跳过`);
    state.lastDate = date; writeJson(STATE_FILE, state);
    return;
  }
  const lines = mine.map((m) => `[${m.key}] ${m.text}`).join('\n').slice(0, 12000);
  const prompt = `你是 Pluto 的复盘助手。下面是她在 ${date} 这一天在 QQ 里说过的话（每行一条，前面是会话），以及桥接记录的错误行。
请检查：
1. 有没有说错话/答非所问/冒犯/重复刷屏/泄露隐私/承诺了没做到；
2. 有没有明显该回却没回的（从错误行里看）；
3. 每条问题给出：type、severity(low/medium/high)、detail、fixable(true/false)、fix(能自修的具体动作)。
只输出 JSON：{"summary":"一句话总结","issues":[{"type":"","severity":"low","detail":"","fixable":true,"fix":""}]}，没有问题就 issues 为空数组。
她说的话：
${lines}

错误行：
${errors.join('\n') || '（无）'}`;
  const raw = await callModel(prompt);
  const parsed = parseJson(raw) || { summary: '模型输出不可解析', issues: [], parseError: true };
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const stats = summarizeIssues(issues);

  fs.mkdirSync(REVIEWS, { recursive: true });
  const fixes = issues.filter((i) => i?.fixable !== false && i?.fix);
  const fixText = fixes.length
    ? `\n## 自修记录\n\n${fixes.map((i) => `- [${i.type ?? '问题'}] ${i.fix}`).join('\n')}\n`
    : '';
  const md = `# 复盘 ${date}\n\n## 总结\n\n${parsed.summary || '（无）'}\n\n## 问题（${issues.length}）\n\n${
    issues.length ? issues.map((i) => `- [${i.severity ?? 'low'}${i.fixable === false ? ' / 不可自修' : ''}] ${i.type ?? ''}：${i.detail ?? ''}${i.fix ? `\n  - 处理：${i.fix}` : ''}`).join('\n') : '（无）'
  }\n${fixText}\n## 数据\n\n- 发言：${mine.length} 条\n- 错误行：${errors.length} 条\n`;
  fs.writeFileSync(path.join(REVIEWS, `${date}.md`), md, 'utf8');

  const needNotify = parsed.parseError || decideNotify(issues);
  if (needNotify) {
    const brief = issues.filter((i) => i?.severity === 'high' || i?.fixable === false).slice(0, 5)
      .map((i) => `· ${i.type ?? '问题'}：${String(i.detail ?? '').slice(0, 80)}`).join('\n');
    const msg = `【夜间复盘 ${date}】${parsed.summary || ''}\n问题 ${stats.total} 个（高危 ${stats.high}，不可自修 ${stats.unfixable}）\n${brief || '（详见笔记）'}\n详见 agent-home/notes/reviews/${date}.md`;
    const r = await notifyOwner(msg);
    log(`通知主人：${r.ok ? '成功' : '失败 ' + (r.error ?? '')}`);
  }
  state.lastDate = date;
  writeJson(STATE_FILE, state);
  try { const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'persona-reflect.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); log('已拉起人格复盘'); } catch {}
  try { const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'memory-consolidate.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); log('已拉起记忆整理'); } catch {}
  try { const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'persona-merge.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); log('已检查人格周合并'); } catch {}
  log(`${date} 复盘完成：发言 ${mine.length}，问题 ${stats.total}，通知=${needNotify}`);
}

const cliDate = (() => { const i = process.argv.indexOf('--date'); return i >= 0 ? process.argv[i + 1] : ''; })();
if (cliDate) { try { await runReview(cliDate, windowFor(cliDate)); } catch (e) { log('复盘失败：' + (e?.message ?? e)); } process.exit(0); }
log(`nightly-review 启动（每天 ${String(rc.hour).padStart(2, '0')}:${String(rc.minute).padStart(2, '0')} 复盘前一天）`);
setInterval(async () => {
  const now = new Date();
  const window = reviewWindow(now.getTime());
  if (state.lastDate === window.date) return;
  const hh = now.getHours();
  const mm = now.getMinutes();
  // 00:05 之后、当天任意时间都可以补跑；不重复
  if (hh < rc.hour || (hh === rc.hour && mm < rc.minute)) return;
  await runReview(window.date);
}, 10 * 60 * 1000);
