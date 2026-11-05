// 夜间记忆整理：最近 24h 事件 → 对话摘要 + 人物最近印象；幂等。
// 用法：node tools/memory-consolidate.mjs [hours=24]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMemory, consolidateSkills, decayMemories, openMemory, recentEvents, upsertPerson } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'memory-consolidate.log');
const HOURS = Math.max(1, Math.min(72, Number(process.argv[2]) || 24));
const since = Date.now() - HOURS * 3600 * 1000;
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };

const events = recentEvents({ since, limit: 500 });
if (!events.length) { log('没有需要整理的事件'); process.exit(0); }
const db = openMemory();
const day = new Date().toISOString().slice(0, 10);
let summaries = 0;
let people = 0;

const byConv = new Map();
for (const e of events) {
  if (!e.conversation_key) continue;
  if (!byConv.has(e.conversation_key)) byConv.set(e.conversation_key, []);
  byConv.get(e.conversation_key).push(e);
}
for (const [key, list] of byConv) {
  if (list.length < 3) continue;
  const existing = db.prepare("SELECT id FROM memories WHERE type='event-summary' AND subject=? AND valid_from >= ? LIMIT 1").get(key, Date.parse(day + 'T00:00:00'));
  if (existing) continue;
  const lines = list.slice(-12).map((e) => `${new Date(e.occurred_at).toLocaleString('zh-CN', { hour12: false })} ${e.actor_name || '?'}：${String(e.text).slice(0, 90)}`);
  addMemory({ type: 'event-summary', subject: key, scope: 'conversation', text: `${day} ${key} 近况：\n` + lines.join('\n'), validFrom: Date.now(), source: 'nightly', confidence: 0.7 });
  summaries++;
}

const byActor = new Map();
for (const e of events) {
  if (!e.actor_id || e.actor_id === '10003') continue;
  if (!byActor.has(e.actor_id)) byActor.set(e.actor_id, []);
  byActor.get(e.actor_id).push(e);
}
for (const [qq, list] of byActor) {
  const recent = list.slice(-3).map((e) => String(e.text).slice(0, 80)).join(' / ');
  upsertPerson({ qq, names: {}, summary: recent.slice(0, 300), lastSeenAt: list[list.length - 1].occurred_at });
  people++;
}

const skills = consolidateSkills();
decayMemories(90);
log(`整理完成：事件 ${events.length}，对话摘要 ${summaries}，人物 ${people}，条件反射 ${skills}`);
