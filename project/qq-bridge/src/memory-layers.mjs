// 分层记忆检索：原始事件 → 日摘要 → 周摘要 → 长期画像。
// A05-rework1：压缩层不再默认全局可见；每份摘要必须有明确 scope，旧数据未知时保守排除。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hybridSearch } from './memory-store.mjs';
import { knowledgeBrief } from './memory-knowledge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.resolve(HERE, '..', '..', 'agent-home', 'memory');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoWeek = (d = new Date()) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - y) / 86400000) + 1) / 7)).padStart(2, '0')}`; };
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const fmt = (t) => { try { return new Date(Number(t)).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

function allowedList(scopes) {
  return (Array.isArray(scopes) ? scopes : []).map(String).filter(Boolean);
}

function canSee(scope, allowed) {
  const s = String(scope ?? '');
  if (!s) return false;
  return s === 'shared' || allowed.includes(s);
}

/** 读取带 scope 的摘要；没有明确 scope 的旧文件返回 fallback，不会被当作 shared。 */
function readScopedJson(file, allowed) {
  const data = readJson(file, null);
  if (!data || typeof data !== 'object') return null;
  if (!canSee(data.scope, allowed)) return null;
  return data;
}

export function layeredMemoryBrief({ query = '', now = new Date(), rawLimit = 2, scopes = [] } = {}) {
  const allowed = allowedList(scopes);
  const parts = [];
  try {
    const rel = readScopedJson(path.join(MEM, 'profile', 'relationships.json'), allowed);
    if (rel?.owner?.summary) parts.push('【长期关系】' + String(rel.owner.summary).slice(0, 220));
    const profile = readScopedJson(path.join(MEM, 'profile', 'bilibili.json'), allowed);
    if (profile?.interests?.length) {
      const top = profile.interests.filter((x) => ['active', 'dormant'].includes(x.status)).slice(0, 5);
      if (top.length) parts.push('【长期画像】B站偏好：' + top.map((x) => `${x.name}(${Number(x.weight).toFixed(1)})`).join('、'));
    }
    const week = readScopedJson(path.join(MEM, 'weekly', isoWeek(now) + '.json'), allowed);
    if (week?.summary) parts.push('【本周】' + String(week.summary).slice(0, 260));
    const month = readScopedJson(path.join(MEM, 'monthly', monthKey(now) + '.json'), allowed);
    if (month?.summary) parts.push('【本月】' + String(month.summary).slice(0, 220));
    for (let i = 0; i < 2; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      const daily = readScopedJson(path.join(MEM, 'daily', dayKey(d) + '.json'), allowed);
      if (daily?.summary) parts.push(`【${i === 0 ? '今天' : '昨天'}】` + String(daily.summary).slice(0, 220));
    }
    if (query) {
      const kb = knowledgeBrief(query, 2, { scopes: allowed });
      if (kb) parts.push(kb.trim());
    }
    if (query && parts.length < 8) {
      const hits = hybridSearch(query, rawLimit, { scopes: allowed }).filter((x) => x?.text);
      if (hits.length) parts.push('【相关原始记忆】\n' + hits.map((x) => `- ${fmt(x.occurred_at)} ${x.actor_name || '?'}：${String(x.text).slice(0, 100)}`).join('\n'));
    }
  } catch {}
  const text = parts.join('\n');
  return text ? `【分层记忆】\n${text.slice(0, 1400)}\n\n` : '';
}
