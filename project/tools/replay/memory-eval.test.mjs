// S6.4：记忆评测（20 题）。只跑离线可判定的部分；做不到的显式标 GAP，
// 不用"看起来对"冒充通过。
//
// 检索语义按 memory-mcp/server.mjs 的规则复刻：子串计分（整句命中 +2）、
// impression/affinity 加权 +1.5、7 天内的 chat +2、返回 snippet。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPeople, touchPerson, addImpression, getPerson, formatPersonLine, recentImpressions,
} from '../../qq-bridge/src/people.js';
import { buildCrossGroupDigest } from '../../qq-bridge/src/cross-group.js';
import { readStateFile, writeStateFile } from '../../qq-bridge/src/state-file.js';

const rows = [];
const add = (id, q, status, note = '') => rows.push({ id, q, status, note });
const run = (id, q, fn) => {
  try { fn(); add(id, q, 'PASS'); } catch (e) { add(id, q, 'FAIL', e.message.slice(0, 70)); }
};
const gap = (id, q, why) => add(id, q, 'GAP', why);

// ── 复刻 memory-mcp 的检索 ─────────────────────────────────────────────────
function search(records, query, now = Date.now()) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const rec of records) {
    const hay = String(rec.text ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      let idx = hay.indexOf(term);
      while (idx !== -1) { score += term === q ? 2 : 1; idx = hay.indexOf(term, idx + term.length); }
    }
    if (score === 0) continue;
    if (rec.source === 'impression' || rec.source === 'affinity') score += 1.5;
    if (rec.source === 'chat' && rec.ts && now - rec.ts < 7 * 864e5) score += 2;
    const at = hay.indexOf(q) !== -1 ? hay.indexOf(q) : Math.max(0, hay.indexOf(terms[1] ?? q));
    const snippet = String(rec.text ?? '').slice(Math.max(0, at - 40), at + 120);
    hits.push({ score: Math.round(score * 10) / 10, source: rec.source, where: rec.where, text: snippet });
  }
  return hits.sort((a, b) => b.score - a.score);
}

const emptyDb = () => loadPeople(path.join(os.tmpdir(), `mem-${process.pid}-${Math.random().toString(36).slice(2)}.json`));

// 1–2：昵称与改名
run(1, '同一个人在两个群的昵称都能查到', () => {
  const db = emptyDb();
  touchPerson(db, { qq: '10002', name: '示例群友甲', groupKey: 'group:A' });
  touchPerson(db, { qq: '10002', name: '示例群友乙', groupKey: 'group:B' });
  const line = formatPersonLine(getPerson(db, '10002'));
  assert.ok(line.includes('示例群友甲') && line.includes('示例群友乙'));
});

run(2, '改名后旧昵称仍保留（不丢历史）', () => {
  const db = emptyDb();
  touchPerson(db, { qq: '1111', name: '旧名', groupKey: 'group:A' });
  touchPerson(db, { qq: '1111', name: '新名', groupKey: 'group:A' });
  assert.equal(getPerson(db, '1111').names['group:A'], '新名');
  touchPerson(db, { qq: '1111', name: '旧名', groupKey: 'group:B' });
  assert.ok(formatPersonLine(getPerson(db, '1111')).includes('旧名'));
});

// 3–5：scope 隔离
run(3, '群聊上下文不含私聊印象', () => {
  const db = emptyDb();
  addImpression(db, { qq: '2222', text: '私聊里说的秘密', groupKey: 'private:1' });
  addImpression(db, { qq: '2222', text: '群里聊过的事', groupKey: 'group:A' });
  const line = formatPersonLine(getPerson(db, '2222'), { scope: 'group' });
  assert.ok(!line.includes('秘密'));
  assert.ok(line.includes('群里聊过的事'));
});

run(4, '私聊上下文能看到群里的印象', () => {
  const db = emptyDb();
  addImpression(db, { qq: '3333', text: '群里的事', groupKey: 'group:A' });
  assert.ok(formatPersonLine(getPerson(db, '3333'), { scope: 'private' }).includes('群里的事'));
});

run(5, '无 scope 的旧数据只在私聊出现', () => {
  const db = emptyDb();
  addImpression(db, { qq: '4444', text: '老数据', groupKey: '' });
  assert.ok(!formatPersonLine(getPerson(db, '4444'), { scope: 'group' }).includes('老数据'));
  assert.ok(formatPersonLine(getPerson(db, '4444'), { scope: 'private' }).includes('老数据'));
});

// 6：查无此人
run(6, '查无此人返回空，不编造', () => {
  const db = emptyDb();
  assert.equal(getPerson(db, '999999'), null);
  assert.equal(formatPersonLine(null), '');
});

// 7–8：容量与去重
run(7, '印象上限 30 条', () => {
  const db = emptyDb();
  for (let i = 0; i < 40; i++) addImpression(db, { qq: '5555', text: `印象${i}` });
  assert.equal(getPerson(db, '5555').impressions.length, 30);
});

run(8, '重复印象只存一次', () => {
  const db = emptyDb();
  addImpression(db, { qq: '6666', text: '话多' });
  addImpression(db, { qq: '6666', text: '话多' });
  assert.equal(recentImpressions(getPerson(db, '6666')).length, 1);
});

// 9–13：跨群摘要
const now = 10_000_000;
const convs = {
  'group:A': { recentMessages: [{ sender: '示例群友甲', text: 'A 群的话', time: now - 1000 }] },
  'group:B': { recentMessages: [{ sender: '纱布丁', text: 'B 群的切片', time: now - 2000 }] },
  'private:1': { recentMessages: [{ sender: '私聊', text: '私聊秘密', time: now - 500 }] },
};

run(9, '摘要不含私聊', () => {
  const d = buildCrossGroupDigest({ conversations: convs, currentKey: 'group:A', now });
  assert.ok(!d.lines.some((l) => l.includes('私聊秘密')));
});

run(10, '摘要不含当前群自己的消息', () => {
  const d = buildCrossGroupDigest({ conversations: convs, currentKey: 'group:A', now });
  assert.ok(!d.lines.some((l) => l.includes('A 群的话')));
});

run(11, '摘要遵守时间窗', () => {
  const old = { 'group:C': { recentMessages: [{ sender: 'x', text: '很久以前', time: now - 3 * 3600e3 }] } };
  const d = buildCrossGroupDigest({ conversations: old, currentKey: 'group:A', now });
  assert.equal(d.lines.length, 0);
});

run(12, '摘要条数上限', () => {
  const many = {};
  for (let g = 0; g < 5; g++) many[`group:${g}`] = { recentMessages: Array.from({ length: 20 }, (_, i) => ({ sender: `u${i}`, text: `t${i}`, time: now })) };
  const d = buildCrossGroupDigest({ conversations: many, currentKey: 'group:X', now, opts: { maxLines: 8 } });
  assert.ok(d.lines.length <= 8);
});

run(13, '摘要里自己的发言标成"你"', () => {
  const c = { 'group:B': { recentMessages: [{ sender: 'Pluto.', text: '我说的', time: now, isSelf: true }] } };
  const d = buildCrossGroupDigest({ conversations: c, currentKey: 'group:A', now });
  assert.ok(d.lines.some((l) => l.includes('你：')));
});

// 14–18：检索
const corpus = [
  { source: 'note', where: 'notes/a.md', text: '寿喜烧的做法：先煎后煮' },
  { source: 'kb', where: 'kb/bili/2026-10-22.md', text: '黑神话悟空 DLC 评测' },
  { source: 'impression', where: 'qq:10002', text: '寿喜烧爱好者' },
  { source: 'chat', where: 'group:A', text: '昨天聊到寿喜烧', ts: now - 864e5 },
];

run(14, 'KB 条目可检索且带来源', () => {
  const hits = search(corpus, '黑神话');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].where.includes('kb/'));
});

run(15, '查不到就返回空（不硬凑）', () => {
  assert.deepEqual(search(corpus, '量子引力'), []);
});

run(16, '印象权重高于普通笔记', () => {
  const hits = search(corpus, '寿喜烧');
  assert.equal(hits[0].source, 'impression');
});

run(17, '检索大小写不敏感', () => {
  const c = [{ source: 'note', where: 'x', text: 'iPhone 评测' }];
  assert.equal(search(c, 'iphone').length, 1);
});

run(18, '返回片段包含查询词', () => {
  const hits = search(corpus, 'DLC');
  assert.ok(hits[0].text.includes('DLC'));
});

// 19：状态文件可读
run(19, '状态文件带版本可读（备份恢复用）', () => {
  const f = path.join(os.tmpdir(), `mem-state-${process.pid}.json`);
  writeStateFile(f, { people: {} }, { revision: 0 });
  const r = readStateFile(f);
  assert.equal(r.schemaVersion, 2);
  fs.rmSync(f, { force: true });
});

// 20 与 GAP：做不到的显式列出
gap(20, '过期事实自动失效（TTL）', 'people/kb 没有 expiresAt 语义，需先设计字段');
gap('A', '否定句（"不喜欢 X"）不被当成喜欢', '关键词检索无极性判断，属模型理解层');
gap('B', '群内玩笑/反讽不被当事实', '同上，无语气分类器');
gap('C', '同名用户不自动绑定', 'group-address 仅唯一包含关系才绑定，需真实成员数据验证');
gap('D', '日记推断不升级为事实', 'memory-mcp 不区分推断/事实来源');

const pass = rows.filter((r) => r.status === 'PASS').length;
const fail = rows.filter((r) => r.status === 'FAIL').length;
const gaps = rows.filter((r) => r.status === 'GAP').length;
console.log('ID  结果  问题');
for (const r of rows) console.log(`${String(r.id).padStart(2)}  ${r.status.padEnd(5)} ${r.q}${r.note ? ' — ' + r.note : ''}`);
console.log(`\n记忆评测：PASS ${pass} / FAIL ${fail} / GAP ${gaps}`);
process.exit(fail ? 1 : 0);
