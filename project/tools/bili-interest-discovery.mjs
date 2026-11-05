// 每周 B 站兴趣发现：从最近观看中找候选主题，再由模型判断是否符合 Pluto 人设。
// 规则：每周最多转正 1 个；旧兴趣不删除；不符合人设的只记录 rejected，不进入画像。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const MEM = path.join(ROOT, 'agent-home', 'memory');
const PROFILE = path.join(MEM, 'profile', 'interests.json');
const CURRENT = path.join(STATE, 'bili-interests.json');
const HISTORY = path.join(STATE, 'bili-watch-history.jsonl');
const LOG = path.join(MEM, 'interest-discovery.log');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, f); };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const persona = (() => { try { return fs.readFileSync(path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'persona.prompt.txt'), 'utf8').slice(0, 2600); } catch { return ''; } })();
const BAD = /^(模拟器推荐|随机推荐|兴趣|B站|封面语义|的版本|v50|v50的版本|游戏直播画面|画面|图片)$/i;
const cutoff = Date.now() - 7 * 86400000;
const rows = (() => { try { return fs.readFileSync(HISTORY, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
const recent = rows.filter((r) => Number(r.at) >= cutoff);
const counts = new Map();
for (const r of recent) {
  const raw = String(r.interest || '').replace(/^兴趣[:：]?/, '');
  for (const x of raw.split(/[\/、,，\s]+/)) { const n = String(x || '').trim(); if (n.length >= 2 && !BAD.test(n)) counts.set(n, (counts.get(n) || 0) + 1); }
}
const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).filter(([name, n]) => n >= 3).slice(0, 8).map(([name, n]) => ({ name, count: n }));
const current = readJson(PROFILE, { interests: [] });
const known = new Set([...(current.interests || []).map((x) => x.name), ...((readJson(CURRENT, {}).interests || []).map((x) => x.name))]);
const fresh = candidates.filter((x) => !known.has(x.name) && ![...known].some((k) => k.includes(x.name) || x.name.includes(k)));
if (!fresh.length) { log('没有候选新兴趣'); process.exit(0); }

async function judge(cand) {
  const v = cfg.socialV2?.vision || {};
  const key = cfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return null;
  const prompt = `你是 Pluto 的人设审核器。Pluto 是18岁北京大一汉语言文学女生，住校，喜欢游戏/猫/独立音乐/写作，性格自然、有主体性。判断候选兴趣是否符合她的人设，而不是只看“热不热门”。
候选兴趣：${cand.name}
最近7天在B站出现：${cand.count} 次
人设片段：${persona}
只输出 JSON：{"fit":true或false,"reason":"20字内","suggestedName":"如果 fit 且名称更自然，给出一个更具体的名字；否则同名"}
不要因为候选是教程/数码/泛热点就自动通过；要像真实女生会不会主动看。`;
  try {
    const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 220, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => null); const text = String(j?.choices?.[0]?.message?.content || '');
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
  } catch { return null; }
}

const old = readJson(PROFILE, { interests: [], updatedAt: 0, rejected: [] });
let added = 0; const addedNames = [];
for (const cand of fresh) {
  const verdict = await judge(cand);
  if (!verdict) { log('模型未返回，跳过 ' + cand.name); continue; }
  if (verdict.fit !== true) { old.rejected = [...(old.rejected || []).slice(-20), { name: cand.name, reason: String(verdict.reason || ''), at: Date.now() }]; log('不符合人设，拒绝：' + cand.name + '（' + verdict.reason + '）'); continue; }
  const name = String(verdict.suggestedName || cand.name).slice(0, 40);
  if (added >= 1) break;
  if (!(old.interests || []).some((x) => x.name === name)) {
    old.interests = [...(old.interests || []), { name, weight: 1, status: 'active', source: 'discovered', evidenceCount: cand.count, addedAt: Date.now(), lastSeenAt: Date.now(), reason: String(verdict.reason || '').slice(0, 120) }];
    added++; addedNames.push({ name, reason: String(verdict.reason || ''), evidenceCount: cand.count, at: Date.now() });
    log('新兴趣转正：' + name + '（' + verdict.reason + '）');
  }
}
writeJson(PROFILE, { updatedAt: Date.now(), interests: old.interests || [], rejected: old.rejected || [] });
if (addedNames.length) {
  try {
    const bpFile = path.join(MEM, 'profile', 'bilibili.json');
    const bp = readJson(bpFile, { interests: [] });
    const map = new Map((bp.interests || []).map((x) => [x.name, x]));
    for (const x of addedNames) map.set(x.name, { name: x.name, weight: 1, status: 'active', source: 'discovered', reason: x.reason, evidenceCount: x.evidenceCount, firstSeen: x.at, lastSeenAt: x.at });
    bp.discovered = [...(bp.discovered || []).slice(-20), ...addedNames];
    writeJson(bpFile, bp);
    const wf = path.join(MEM, 'weekly', (() => { const d = new Date(); const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - y) / 86400000) + 1) / 7)).padStart(2, '0')}`; })() + '.json');
    const wk = readJson(wf, null);
    if (wk) { wk.newInterests = [...(wk.newInterests || []), ...addedNames]; writeJson(wf, wk); }
  } catch {}
}
if (added) {
  const cur = readJson(CURRENT, { date: '', interests: [] });
  const merge = new Map((cur.interests || []).map((x) => [x.name, x]));
  for (const x of old.interests || []) if (x.status === 'active') merge.set(x.name, { name: x.name, weight: Math.max(1, Math.min(3, Number(x.weight) || 1)) });
  cur.interests = [...merge.values()].slice(0, 8);
  writeJson(CURRENT, cur);
}
