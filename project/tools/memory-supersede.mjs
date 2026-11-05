// 通用记忆语义去重：相似记忆只标记 superseded，不删除原记录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMemories, supersedeMemory } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(ROOT, 'agent-home', 'memory');
const REPORT = path.join(MEM, 'supersede-report.json');
const MEMORIES = listMemories(2000).filter((x) => x.status === 'active' || !x.status);
const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const bigrams = (s) => { const a = []; const x = norm(s); for (let i = 0; i < x.length - 1; i++) a.push(x.slice(i, i + 2)); return new Set(a); };
const sim = (a, b) => { const A = bigrams(a); const B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / Math.max(A.size, B.size); };
const groups = new Map();
for (const m of MEMORIES) { const k = `${m.type || ''}|${m.subject || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
const marked = [];
for (const list of groups.values()) {
  list.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.updated_at || 0) - Number(a.updated_at || 0));
  for (let i = 0; i < list.length; i++) {
    const keep = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const old = list[j];
      if (sim(keep.text, old.text) < 0.78) continue;
      if (supersedeMemory(old.id, keep.id, 'semantic duplicate')) marked.push({ oldId: old.id, keepId: keep.id, subject: old.subject, at: Date.now() });
    }
  }
}
fs.mkdirSync(MEM, { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), total: MEMORIES.length, superseded: marked, note: '原记录保留，只改 status/superseded_by' }, null, 2) + '\n', 'utf8');
console.log('superseded', marked.length);
