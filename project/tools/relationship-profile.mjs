// 聊天长期关系画像：主人关系 + 群友关系。只看统计数据与聊天素材，不编造。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemory } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(ROOT, 'agent-home', 'memory');
const OUT = path.join(MEM, 'profile', 'relationships.json');
const LOG = path.join(MEM, 'relationship-profile.log');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const cfg = read(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const ownerQQ = String(cfg.ownerQQ || '');
const d = openMemory();
const since = Date.now() - 90 * 86400000;
const ownerKey = 'private:' + ownerQQ;
let ownerRows = [];
try { ownerRows = d.prepare('SELECT occurred_at,source,actor_name,text FROM events WHERE conversation_key=? AND occurred_at>=? ORDER BY occurred_at DESC LIMIT 600').all(ownerKey, since); } catch {}
let people = [];
try { people = d.prepare('SELECT qq,names_json,summary,last_seen_at FROM people ORDER BY last_seen_at DESC LIMIT 12').all(); } catch {}
const ownerLines = ownerRows.slice(0, 200).map((e) => `${new Date(e.occurred_at).toLocaleString('zh-CN', { hour12: false })} ${e.actor_name || e.source}：${String(e.text).slice(0, 140)}`).join('\n');
const fallback = {
  owner: { qq: ownerQQ, summary: `最近90天和主人私聊记录 ${ownerRows.length} 条。`, closeness: 4, patterns: [], topics: [], openLoops: [] },
  others: people.map((p) => { let names = {}; try { names = JSON.parse(p.names_json || '{}'); } catch {} return { qq: p.qq, name: Object.values(names)[0] || p.qq, names, summary: p.summary || '', lastSeenAt: p.last_seen_at }; })
};
const prompt = `根据下面的真实聊天素材，生成长期关系画像 JSON，不要编造素材里没有的人和事：
{"owner":{"qq":"${ownerQQ}","summary":"100字内描述和主人的长期关系","closeness":1-5,"patterns":["互动模式"],"topics":["常聊话题"],"openLoops":["未完成的事"]},"others":[{"qq":"","name":"","summary":"20字内","lastSeenAt":0}]}
素材：\n${ownerLines.slice(0, 7000)}`;
async function ask() {
  const v = cfg.socialV2?.vision || {}; const key = cfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return null;
  try {
    const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 800, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => null); const text = String(j?.choices?.[0]?.message?.content || '');
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
  } catch { return null; }
}
const model = await ask();
const data = {
  updatedAt: Date.now(),
  owner: { ...(fallback.owner), ...(model?.owner || {}), qq: ownerQQ, messageCount: ownerRows.length },
  others: (Array.isArray(model?.others) && model.others.length ? model.others : fallback.others).map((x) => ({ ...x, names: fallback.others.find((p) => String(p.qq) === String(x.qq))?.names || x.names || {} })),
  note: '只追加历史快照；旧画像不删除'
};
const old = read(OUT, { history: [] });
data.history = [...(old.history || []).slice(-11), { at: data.updatedAt, owner: data.owner, others: data.others.slice(0, 8) }];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const tmp = OUT + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, OUT);
log(`关系画像更新：主人消息 ${ownerRows.length}，群友 ${data.others.length}`);
