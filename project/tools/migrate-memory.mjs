// 回填最近 30 天的统一时间线记忆（幂等）。
// 用法：node tools/migrate-memory.mjs [days=30]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEvent, addPlatformItem, openMemory, stats, upsertPerson } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const DAYS = Math.max(1, Math.min(365, Number(process.argv[2]) || 30));
const CUTOFF = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

openMemory();
let counts = { events: 0, people: 0, platform: 0, notes: 0, skipped: 0 };

// QQ 最近消息
const social = read(path.join(STATE, 'social-v2.json'), { conversations: {} });
for (const [key, conv] of Object.entries(social.conversations || {})) {
  for (const m of Array.isArray(conv.recentMessages) ? conv.recentMessages : []) {
    const t = Number(m?.time) || 0;
    if (t < CUTOFF) { counts.skipped++; continue; }
    const text = String(m?.text || m?.plain || '').trim();
    if (!text) continue;
    const id = addEvent({
      occurredAt: t,
      source: 'qq',
      conversationKey: key,
      actorId: m?.isSelf ? '10003' : m?.userId,
      actorName: m?.isSelf ? 'Pluto' : (m?.sender || ''),
      kind: 'message',
      text,
      sourceRef: m?.messageId != null ? `qq:${key}:${m.messageId}` : `qq:${key}:${m.seq || t}`,
      importance: m?.isSelf ? 0.5 : 0.6,
      confidence: 0.9,
      meta: { seq: m?.seq, quoteTargetIsSelf: m?.quoteTargetIsSelf, hasMedia: m?.hasMedia },
    });
    if (id) counts.events++;
  }
}

// 人物
const people = read(path.join(STATE, 'people.json'), { people: {} });
for (const [qq, p] of Object.entries(people.people || {})) {
  upsertPerson({ qq, names: p.names || {}, summary: (p.impressions || []).slice(-2).map((x) => String(x.text || x)).join(' / '), lastSeenAt: p.lastSeenAt || Date.now() });
  counts.people++;
}

// B站记忆
const bili = read(path.join(STATE, 'bili-memory.json'), { videos: [] });
for (const v of bili.videos || []) {
  if (!v?.bvid) continue;
  addPlatformItem({ platform: 'bilibili', itemId: v.bvid, title: v.title || '', summary: v.visual || v.activity || '', occurredAt: v.at || Date.now(), meta: { interest: v.interest } });
  counts.platform++;
}

// 笔记（只回填 30 天内修改过的）
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
for (const file of walk(path.join(ROOT, 'agent-home', 'notes'))) {
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs < CUTOFF) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const body = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!body) continue;
    const id = addEvent({ occurredAt: st.mtimeMs, source: 'note', conversationKey: null, actorId: 'note', actorName: path.basename(file, '.md'), kind: 'note', text: body, sourceRef: 'note:' + rel, importance: 0.45, confidence: 0.7 });
    if (id) { counts.notes++; counts.events++; }
  } catch {}
}

console.log(JSON.stringify({ days: DAYS, ...counts, db: stats() }, null, 2));
