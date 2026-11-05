// 人格每日复盘：从最近时间线提取信号，必要时小步修改 evolution 层。
// 用法：node tools/persona-reflect.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentEvents } from '../qq-bridge/src/memory-store.mjs';
import { applyEvolution, currentScore, evolutionStatus, readEvolutionPrompt, recordSignal } from '../qq-bridge/src/persona-evolution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'persona-reflect.log');
const DRY = process.argv.includes('--dry-run');
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const redact = (s) => String(s || '').replace(/https?:\/\/\S+/g, '[链接]').replace(/\b\d{5,12}\b/g, '[号码]').replace(/sk-[A-Za-z0-9]+/g, '[key]');

const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const astra = cfg?.socialV2?.qzone?.astra;
if (!astra?.apiKey) { log('缺少 astra apiKey，跳过'); process.exit(0); }

const since = Date.now() - 24 * 60 * 60 * 1000;
const events = recentEvents({ since, limit: 60 });
if (!events.length) { log('最近 24h 没有事件，跳过'); process.exit(0); }
const lines = events.slice(-50).map((e) => `- ${new Date(e.occurred_at).toLocaleString('zh-CN', { hour12: false })} [${e.source}] ${e.actor_name || e.actor_id || '?'}：${redact(String(e.text || '').slice(0, 160))}`).join('\n');
const prompt = `你是一个人格演化复盘器，不是聊天机器人。根据下面最近 24 小时的 Pluto 事件，判断有没有稳定的人格变化信号。只输出 JSON，不要 markdown。

规则：
- 单次玩梗/挑衅不算信号；至少跨多个上下文或来自主人明确反馈才算。
- 主人明确反馈权重 6；主人重复指出 3；群友独立反馈 1；自省/日志 0.5。
- 只有证据分 >= 8 才建议 change。
- change.content 只能写一小段（<= 300 字）外挂层文本，不能重写核心身份，不能包含“不暴露主人/不承认 AI”的删除或改写。
- 没有稳定信号就 needed=false。

输出格式：
{"signals":[{"source":"owner|group|self|platform","weight":0,"text":"..."}],"change":{"needed":false,"section":"","content":"","reason":"","score":0}}

事件：
${lines}`;

let text = '';
try {
  const r = await fetch(String(astra.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + astra.apiKey },
    body: JSON.stringify({ model: astra.model || 'gpt-6-astra', messages: [{ role: 'user', content: prompt }], max_tokens: 800, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => null);
  text = String(j?.choices?.[0]?.message?.content || '').trim();
} catch (e) { log('模型调用失败：' + (e?.message ?? e)); process.exit(1); }

const jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
let result;
try { result = JSON.parse(jsonText); } catch { log('模型输出不是 JSON：' + text.slice(0, 300)); process.exit(1); }

for (const sig of Array.isArray(result.signals) ? result.signals.slice(0, 20) : []) {
  const source = ['owner', 'group', 'self', 'platform'].includes(String(sig.source)) ? String(sig.source) : 'self';
  const weight = Math.max(0, Math.min(6, Number(sig.weight) || 0));
  if (!weight) continue;
  recordSignal({ source, weight, text: String(sig.text || '').slice(0, 300), context: 'daily-reflect' });
}
const change = result.change || {};
const score = Number(change.score) || 0;
log(`复盘完成：signals=${Array.isArray(result.signals) ? result.signals.length : 0} score=${score} current=${currentScore().toFixed(1)} needed=${!!change.needed}`);
if (change.needed && score >= 8 && String(change.content || '').trim()) {
  const r = DRY ? { ok: true, dryRun: true } : applyEvolution({ section: String(change.section || '表达习惯'), content: String(change.content), reason: String(change.reason || 'daily-reflect'), score, source: 'self' });
  log('apply: ' + JSON.stringify(r) + (DRY ? '（dry-run，未实际写入）' : ''));
} else {
  log('本轮不修改人设');
}
log('status: ' + JSON.stringify(evolutionStatus()) + ' overlayChars=' + readEvolutionPrompt().length);
