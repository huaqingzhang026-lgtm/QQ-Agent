// 从已看过的 B 站视频摘要提取知识卡 + 技能等级。
// 只提取摘要里出现的事实/步骤；不把“看过”当成“会做”。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveKnowledgeCard, upsertSkill, listKnowledge } from '../qq-bridge/src/memory-knowledge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const LOG = path.join(ROOT, 'agent-home', 'memory', 'knowledge-digest.log');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
const summaries = readJson(path.join(STATE, 'bili-video-summaries.json'), {});
const memory = readJson(path.join(STATE, 'bili-memory.json'), { videos: [] });
const existing = new Set(listKnowledge(500).map((x) => x.bvid));
const candidates = (memory.videos || [])
  .filter((v) => v?.bvid && !existing.has(v.bvid) && summaries[v.bvid]?.summary)
  .slice(-40)
  .reverse()
  .slice(0, Math.max(1, Number(process.argv.find((x) => x.startsWith('--limit='))?.split('=')[1]) || 5));

async function ask(prompt) {
  const v = cfg.socialV2?.vision || {};
  const key = cfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return null;
  try {
    const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 900, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(45000)
    });
    const j = await r.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content || '');
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
  } catch { return null; }
}

for (const v of candidates) {
  const summary = String(summaries[v.bvid]?.summary || '').slice(0, 5000);
  const prompt = `从下面的 B 站视频摘要中提取知识卡。只使用摘要里明确出现的内容，不要补充外部知识，不要编造。输出 JSON：
{"topic":"主题（30字内）","contentType":"tutorial或science或intro或entertainment或other","facts":["明确事实，最多8条"],"steps":["操作步骤，最多8条；没有就空数组"],"prerequisites":["前置条件"],"pitfalls":["容易出错的地方"],"is_skill":true或false,"skill_name":"如果这是可操作技能，给出技能名；否则空","confidence":0.5}
标题：${String(v.title || '').slice(0, 160)}
摘要：${summary}`;
  const j = await ask(prompt);
  if (!j) { log('提取失败：' + v.bvid); continue; }
  const topic = String(j.topic || v.title || '').slice(0, 80);
  const steps = Array.isArray(j.steps) ? j.steps : [];
  const type = String(j.contentType || 'other');
  const ok = (steps.length > 0) || ['tutorial', 'science', 'intro'].includes(type) || Number(j.confidence) >= 0.75;
  if (!ok || Number(j.confidence) < 0.5) { log('跳过低价值内容：' + v.bvid + ' type=' + type + ' steps=' + steps.length); continue; }
  saveKnowledgeCard({
    bvid: v.bvid, topic, title: v.title || '', facts: j.facts || [], steps,
    prerequisites: j.prerequisites || [], pitfalls: j.pitfalls || [], confidence: j.confidence ?? 0.5,
    source: 'B站 ' + v.bvid
  });
  if (j.is_skill && j.skill_name && steps.length >= 2 && Number(j.confidence) >= 0.6) {
    upsertSkill({ name: String(j.skill_name), level: 'understood', evidence: '从视频摘要理解：' + String(v.title || '').slice(0, 80), sourceBvid: v.bvid });
  }
  log('知识卡：' + v.bvid + ' ' + topic);
}
