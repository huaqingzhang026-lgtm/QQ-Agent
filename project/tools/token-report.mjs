// Token 消耗统计：按天 / 按会话 key / 按小时，含峰谷价估算。
// 用法：node tools\token-report.mjs [--days 1] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRICE_TABLE } from '../qq-bridge/src/model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'qq-bridge', 'state', 'token-usage.jsonl');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const days = Number(arg('days', 1));
const asJson = process.argv.includes('--json');

const T = DEFAULT_PRICE_TABLE;
function priceFor(model, at) {
  const m = T.models[model] ?? T.models[T.fallbackModel];
  const d = new Date(at);
  const h = d.getHours();
  const wd = d.getDay() === 0 ? 7 : d.getDay();
  const peak = T.peakWeekdays.includes(wd) && T.peakWindows.some(([a, b]) => h >= a && h < b);
  const mul = peak ? T.peakMultiplier : 1;
  return { off: m.off, mul, peak };
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
const rows = [];
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  const b = j.b ?? {};
  rows.push({
    t: j.t, sid: j.sid, key: j.key ?? '', model: j.model ?? T.fallbackModel,
    hit: b.cacheHit ?? 0, miss: b.cacheMiss ?? 0, write: b.cacheWrite ?? 0,
    out: (b.output ?? 0) + (b.reasoning ?? 0),
  });
}

const now = Date.now();
const since = now - days * 864e5;
const sel = rows.filter((r) => r.t >= since);

function agg(list) {
  const a = { calls: 0, hit: 0, miss: 0, write: 0, out: 0, cost: 0 };
  for (const r of list) {
    a.calls++;
    a.hit += r.hit; a.miss += r.miss; a.write += r.write; a.out += r.out;
    const p = priceFor(r.model, r.t);
    a.cost += ((r.hit * p.off.cacheHit + r.miss * p.off.cacheMiss + r.write * p.off.cacheWrite + r.out * p.off.output) / T.unit) * p.mul;
  }
  return a;
}

const total = agg(sel);
const byKey = {};
for (const r of sel) {
  const k = r.key || '(后台任务)';
  (byKey[k] ??= []).push(r);
}
const byHour = {};
for (const r of sel) {
  const h = new Date(r.t).getHours();
  (byHour[h] ??= []).push(r);
}
const bySession = {};
for (const r of sel) (bySession[r.sid] ??= []).push(r);
const topSessions = Object.entries(bySession).map(([sid, list]) => ({ sid, ...agg(list) })).sort((a, b) => b.miss + b.hit - (a.miss + a.hit)).slice(0, 5);

const fmt = (n) => n.toLocaleString('en-US');
const out = {
  window: `最近 ${days} 天`,
  calls: total.calls,
  input: total.hit + total.miss + total.write,
  cacheHit: total.hit,
  cacheMiss: total.miss,
  output: total.out,
  costCNY: Number(total.cost.toFixed(3)),
  byKey: Object.entries(byKey).map(([k, list]) => { const a = agg(list); return { key: k, calls: a.calls, input: a.hit + a.miss + a.write, output: a.out, costCNY: Number(a.cost.toFixed(3)) }; }).sort((a, b) => b.input - a.input),
  topSessions,
  byHour: Object.entries(byHour).map(([h, list]) => { const a = agg(list); return { hour: Number(h), calls: a.calls, input: a.hit + a.miss + a.write, output: a.out, costCNY: Number(a.cost.toFixed(3)) }; }).sort((a, b) => a.hour - b.hour),
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`📊 ${out.window}　调用 ${fmt(out.calls)} 次`);
console.log(`输入 ${fmt(out.input)} tok（命中缓存 ${fmt(out.cacheHit)} / 未命中 ${fmt(out.cacheMiss)}）· 输出 ${fmt(out.output)} tok`);
console.log(`估算花费 ¥${out.costCNY}（峰谷已折算）`);
console.log('\n按会话：');
for (const k of out.byKey) console.log(`  ${k.key.padEnd(22)} ${String(k.calls).padStart(5)} 次  输入 ${fmt(k.input).padStart(12)}  输出 ${fmt(k.output).padStart(8)}  ¥${k.costCNY}`);
console.log('\n按小时（本地时间）：');
console.log('  ' + out.byHour.map((h) => `${String(h.hour).padStart(2, '0')}时 ${fmt(h.input)}/${fmt(h.output)}`).join('\n  '));
console.log('\n最贵的会话：');
for (const s of out.topSessions) console.log(`  ${s.sid}  输入 ${fmt(s.hit + s.miss + s.write)}  输出 ${fmt(s.out)}  ¥${Number(s.cost.toFixed(3))}`);
