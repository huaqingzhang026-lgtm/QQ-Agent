// 人格演化层：evidence → weighted score → small overlay change → versioned rollback.
// Core persona stays in the baked preset; this module only writes the runtime overlay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OVERLAY = path.join(ROOT, 'agent-home', 'persona', 'evolution.md');
const STATE = path.join(ROOT, 'qq-bridge', 'state', 'persona-evolution.json');
const VERSIONS = path.join(ROOT, 'agent-home', 'persona', 'versions');
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'persona-evolution.jsonl');
const DAY = 24 * 60 * 60 * 1000;
const MAX_DAILY = 1;
const MAX_WEEKLY = 3;
const MAX_DIFF = 0.10;
const MAX_DIFF_CHARS = 600;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const logline = (o) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\n', 'utf8'); } catch {} };

function ensure() {
  fs.mkdirSync(path.dirname(OVERLAY), { recursive: true });
  if (!fs.existsSync(OVERLAY)) {
    fs.writeFileSync(OVERLAY, '# 人格演化层\n\n> 运行时覆盖层；核心身份不在这里。\n\n', 'utf8');
  }
  return loadState();
}

export function loadState() {
  return readJson(STATE, {
    version: 0,
    signals: [],
    changes: [],
    sections: {},
    lastAppliedAt: 0,
    lastReflectionAt: 0,
    pausedUntil: 0,
    consecutiveFailures: 0,
  });
}

function saveState(s) { writeJson(STATE, s); }

function decay(signals, now = Date.now()) {
  return (signals || []).filter((x) => now - Number(x.at || 0) < 30 * DAY)
    .map((x) => ({ ...x, score: Number(x.score || x.weight || 0) * Math.pow(0.5, (now - Number(x.at || now)) / (7 * DAY)) }));
}

export function recordSignal({ source = 'self', weight = 1, text = '', context = '', actor = '' } = {}) {
  const s = ensure();
  s.signals.push({ at: Date.now(), source: String(source), weight: Number(weight) || 0, text: String(text).slice(0, 300), context: String(context).slice(0, 120), actor: String(actor) });
  s.signals = decay(s.signals);
  saveState(s);
  logline({ type: 'signal', source, weight, text: String(text).slice(0, 120), context, actor });
}

export function currentScore() {
  const s = ensure();
  return decay(s.signals).reduce((n, x) => n + Number(x.score || 0), 0);
}

export function canApply({ now = Date.now() } = {}) {
  const s = ensure();
  const today = new Date(now).toISOString().slice(0, 10);
  const weekAgo = now - 7 * DAY;
  const daily = (s.changes || []).filter((c) => String(c.at || 0).slice(0, 10) === today).length;
  const weekly = (s.changes || []).filter((c) => Number(c.at || 0) > weekAgo).length;
  if (Number(s.pausedUntil || 0) > now) return { ok: false, reason: 'paused' };
  if (daily >= MAX_DAILY) return { ok: false, reason: 'daily-limit' };
  if (weekly >= MAX_WEEKLY) return { ok: false, reason: 'weekly-limit' };
  if (Number(s.lastAppliedAt || 0) && now - Number(s.lastAppliedAt) < 6 * 60 * 60 * 1000) return { ok: false, reason: 'cooldown' };
  return { ok: true };
}

/**
 * 应用一小段 overlay。content 是整段文本，不是整份人设重写。
 * 调用方必须先确认证据分数；本函数只做安全、备份、限额、写入。
 */
export function applyEvolution({ section = '表达习惯', content = '', reason = '', score = 0, source = 'self', force = false } = {}) {
  const s = ensure();
  const body = String(content || '').trim();
  if (!body) return { ok: false, error: 'empty' };
  const guard = canApply();
  if (!guard.ok && !force) return { ok: false, error: guard.reason };
  const clean = body.replace(/不暴露主人|不承认.{0,3}AI/g, '').trim();
  if (!clean) return { ok: false, error: 'invariant-only' };
  const full = fs.readFileSync(OVERLAY, 'utf8');
  const next = full + `\n## ${String(section).slice(0, 30)}\n\n${clean}\n`;
  const diffRatio = Math.abs(next.length - full.length) / Math.max(1, full.length);
  if (clean.length > MAX_DIFF_CHARS && !force) return { ok: false, error: 'diff-too-large', chars: clean.length };
  if (diffRatio > MAX_DIFF && clean.length > MAX_DIFF_CHARS && !force) return { ok: false, error: 'diff-too-large', diffRatio };

  const version = Number(s.version || 0) + 1;
  const dir = path.join(VERSIONS, String(version).padStart(4, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(OVERLAY, path.join(dir, 'evolution.md'));
  fs.writeFileSync(OVERLAY, next, 'utf8');
  s.version = version;
  s.lastAppliedAt = Date.now();
  s.changes = [...(s.changes || []), { at: Date.now(), version, section, content: clean, reason: String(reason).slice(0, 300), score, source }].slice(-200);
  saveState(s);
  logline({ type: 'apply', version, section, reason, score, source, diffRatio });
  return { ok: true, version, dir };
}

export function pauseEvolution(hours = 24, reason = '') {
  const s = ensure();
  s.consecutiveFailures = Number(s.consecutiveFailures || 0) + 1;
  const h = Number(s.consecutiveFailures) >= 2 ? Math.max(Number(hours) || 24, 168) : (Number(hours) || 24);
  s.pausedUntil = Date.now() + h * 3600 * 1000;
  s.pauseReason = String(reason || '').slice(0, 300);
  saveState(s);
  logline({ type: 'pause', hours: h, reason: s.pauseReason, failures: s.consecutiveFailures });
  return { ok: true, pausedUntil: s.pausedUntil, hours: h };
}

export function resumeEvolution() {
  const s = ensure();
  s.pausedUntil = 0;
  s.consecutiveFailures = 0;
  s.pauseReason = '';
  saveState(s);
  return { ok: true };
}

export function rollback(version) {
  const s = ensure();
  const v = String(version ?? Number(s.version || 0)).padStart(4, '0');
  const file = path.join(VERSIONS, v, 'evolution.md');
  if (!fs.existsSync(file)) return { ok: false, error: 'version-not-found' };
  fs.copyFileSync(file, OVERLAY);
  const next = readJson(STATE, s);
  next.version = Math.max(0, Number(v) - 1);
  next.lastAppliedAt = 0;
  saveState(next);
  logline({ type: 'rollback', version: Number(v) });
  return { ok: true, version: Number(v) };
}

export function readEvolutionPrompt() {
  try {
    ensure();
    const body = fs.readFileSync(OVERLAY, 'utf8').trim();
    if (!body || body.length < 20 || !/##\s+/.test(body)) return '';
    return '【人格演化层】\n' + body.slice(0, 1800) + '\n\n';
  } catch { return ''; }
}

export function evolutionStatus() {
  const s = ensure();
  return { version: s.version, score: currentScore(), changes: (s.changes || []).length, overlay: OVERLAY };
}
