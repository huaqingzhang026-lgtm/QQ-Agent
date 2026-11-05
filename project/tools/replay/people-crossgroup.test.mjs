// 回放：人物记忆（people）与跨群摘要（cross-group）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPeople, savePeople, touchPerson, addImpression, getPerson,
  recentImpressions, formatPersonLine, mergeLegacyImpressions,
} from '../../qq-bridge/src/people.js';
import { buildCrossGroupDigest, formatCrossGroupDigest } from '../../qq-bridge/src/cross-group.js';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass += 1; } catch (e) { failures.push(`${name}: ${e.message}`); }
};

// ── people ─────────────────────────────────────────────────────────────────
check('新库为空且结构正确', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope-does-not-exist.json'));
  assert.deepEqual(db.people, {});
  assert.equal(db.version, 1);
});

check('记录两个群的昵称', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope2.json'));
  touchPerson(db, { qq: '10002', name: '示例群友甲', groupKey: 'group:20001', at: 1000 });
  touchPerson(db, { qq: '10002', name: '示例群友乙', groupKey: 'group:20002', at: 2000 });
  const p = getPerson(db, '10002');
  assert.equal(p.names['group:20001'], '示例群友甲');
  assert.equal(p.names['group:20002'], '示例群友乙');
  assert.equal(p.lastSeenAt, 2000);
});

check('非法 QQ 不建人', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope3.json'));
  assert.equal(touchPerson(db, { qq: 'abc', name: 'x', groupKey: 'group:1' }), null);
  assert.equal(addImpression(db, { qq: '12', text: 'x' }), null);
});

check('印象跨群共享', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope4.json'));
  addImpression(db, { qq: '1111', text: '爱问实验细节', groupKey: 'group:1', at: 1 });
  addImpression(db, { qq: '1111', text: '笑点低', groupKey: 'group:2', at: 2 });
  const p = getPerson(db, '1111');
  assert.equal(p.impressions.length, 2);
  assert.deepEqual(p.impressions.map((x) => x.group), ['group:1', 'group:2']);
});

check('同文印象去重', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope5.json'));
  addImpression(db, { qq: '2222', text: '话多' });
  addImpression(db, { qq: '2222', text: '话多' });
  assert.equal(getPerson(db, '2222').impressions.length, 1);
});

check('印象上限 30 条，保留最新', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope6.json'));
  for (let i = 0; i < 35; i++) addImpression(db, { qq: '3333', text: `印象${i}`, at: i });
  const p = getPerson(db, '3333');
  assert.equal(p.impressions.length, 30);
  assert.equal(p.impressions.at(-1).text, '印象34');
});

check('recentImpressions 新的在前', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope7.json'));
  addImpression(db, { qq: '4444', text: 'a', at: 1 });
  addImpression(db, { qq: '4444', text: 'b', at: 2 });
  const r = recentImpressions(getPerson(db, '4444'), 2);
  assert.deepEqual(r.map((x) => x.text), ['b', 'a']);
});

check('formatPersonLine 含昵称/QQ/印象', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope8.json'));
  touchPerson(db, { qq: '5555', name: '纱布丁', groupKey: 'group:20001' });
  addImpression(db, { qq: '5555', text: '爱发图' });
  const line = formatPersonLine(getPerson(db, '5555'));
  assert.ok(line.includes('纱布丁'));
  assert.ok(line.includes('5555'));
  assert.ok(line.includes('爱发图'));
});

check('空人物不崩', () => {
  assert.equal(formatPersonLine(null), '');
  assert.deepEqual(recentImpressions(null), []);
});

check('保存/读取往返', () => {
  const file = path.join(os.tmpdir(), `people-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  const db = loadPeople(file);
  touchPerson(db, { qq: '6666', name: '测试', groupKey: 'group:1', at: 9 });
  addImpression(db, { qq: '6666', text: '往返' });
  assert.equal(savePeople(file, db), true);
  const back = loadPeople(file);
  assert.equal(getPerson(back, '6666').names['group:1'], '测试');
  assert.equal(recentImpressions(getPerson(back, '6666'))[0].text, '往返');
  fs.rmSync(file, { force: true });
});

check('损坏文件回退空表', () => {
  const file = path.join(os.tmpdir(), `people-bad-${process.pid}.json`);
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.deepEqual(loadPeople(file).people, {});
  fs.rmSync(file, { force: true });
});

check('legacy 迁移只认数字键', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope9.json'));
  const n = mergeLegacyImpressions(db, {
    conversationKey: 'group:1',
    impressions: { '7777': '旧印象', 示例群友甲: '不该迁移', '8888': { text: '对象形式' } },
  });
  assert.equal(n, 2);
  assert.equal(recentImpressions(getPerson(db, '7777'))[0].text, '旧印象');
  assert.equal(recentImpressions(getPerson(db, '8888'))[0].text, '对象形式');
});

// ── cross-group ─────────────────────────────────────────────────────────────
const now = 10_000_000;
const convs = {
  'group:1': {
    recentMessages: [
      { sender: '示例群友甲', text: '今晚开播吗', time: now - 60000, isSelf: false },
      { sender: 'Pluto.', text: '不知道诶', time: now - 50000, isSelf: true },
    ],
  },
  'group:2': {
    recentMessages: [
      { sender: '纱布丁', text: '昨天那个切片笑死', time: now - 30000, isSelf: false },
      { sender: '老消息', text: '很久以前', time: now - 3 * 3600e3, isSelf: false },
    ],
  },
  'private:10001': {
    recentMessages: [{ sender: '私聊', text: '这是私聊秘密', time: now - 10000, isSelf: false }],
  },
};

check('跨群摘要包含另一个群', () => {
  const d = buildCrossGroupDigest({ conversations: convs, currentKey: 'group:1', now });
  assert.ok(d.lines.some((l) => l.includes('切片')));
  assert.ok(d.lines.some((l) => l.startsWith('[群2]')));
});

check('不包含当前群自己的消息', () => {
  const d = buildCrossGroupDigest({ conversations: convs, currentKey: 'group:1', now });
  assert.ok(!d.lines.some((l) => l.includes('今晚开播吗')));
});

check('绝不包含私聊内容', () => {
  for (const currentKey of ['group:1', 'group:2']) {
    const d = buildCrossGroupDigest({ conversations: convs, currentKey, now });
    assert.ok(!d.lines.some((l) => l.includes('私聊秘密')));
  }
});

check('超出时间窗口的消息不出现', () => {
  const d = buildCrossGroupDigest({ conversations: convs, currentKey: 'group:1', now });
  assert.ok(!d.lines.some((l) => l.includes('很久以前')));
});

check('总数上限生效', () => {
  const many = {
    'group:a': { recentMessages: Array.from({ length: 20 }, (_, i) => ({ sender: `u${i}`, text: `m${i}`, time: now - i * 1000 })) },
    'group:b': { recentMessages: Array.from({ length: 20 }, (_, i) => ({ sender: `v${i}`, text: `n${i}`, time: now - i * 1000 })) },
  };
  const d = buildCrossGroupDigest({ conversations: many, currentKey: 'group:c', now, opts: { maxLines: 8 } });
  assert.ok(d.lines.length <= 8);
});

check('长文本被截断', () => {
  const long = { 'group:x': { recentMessages: [{ sender: 'a', text: 'x'.repeat(300), time: now }] } };
  const d = buildCrossGroupDigest({ conversations: long, currentKey: 'group:y', now, opts: { maxCharsPerLine: 20 } });
  assert.ok(d.lines[0].length < 80);
  assert.ok(d.lines[0].includes('…'));
});

check('空会话返回空摘要且格式化空串', () => {
  const d = buildCrossGroupDigest({ conversations: {}, currentKey: 'group:1', now });
  assert.deepEqual(d.lines, []);
  assert.equal(formatCrossGroupDigest(d), '');
});

check('格式化包含提示语', () => {
  const d = buildCrossGroupDigest({ conversations: convs, currentKey: 'group:1', now });
  const s = formatCrossGroupDigest(d);
  assert.ok(s.includes('【别的群刚聊到】'));
  assert.ok(s.includes('别把私聊内容带出来'));
});

check('群聊看不到私聊来源的印象', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope10.json'));
  addImpression(db, { qq: '9999', text: '私聊里说的秘密', groupKey: 'private:10001' });
  addImpression(db, { qq: '9999', text: '群里聊过的事', groupKey: 'group:20001' });
  const person = getPerson(db, '9999');
  const forGroup = formatPersonLine(person, { scope: 'group' });
  assert.ok(forGroup.includes('群里聊过的事'));
  assert.ok(!forGroup.includes('私聊里说的秘密'));
  const forPrivate = formatPersonLine(person, { scope: 'private' });
  assert.ok(forPrivate.includes('私聊里说的秘密'));
});

check('无 scope 参数时返回全部', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope11.json'));
  addImpression(db, { qq: '8888', text: 'a', groupKey: 'private:1' });
  addImpression(db, { qq: '8888', text: 'b', groupKey: 'group:2' });
  const line = formatPersonLine(getPerson(db, '8888'));
  assert.ok(line.includes('a') && line.includes('b'));
});

check('群聊不出现仅私聊的昵称', () => {
  const db = loadPeople(path.join(os.tmpdir(), 'nope12.json'));
  touchPerson(db, { qq: '7777', name: '私聊昵称', groupKey: 'private:10001' });
  touchPerson(db, { qq: '7777', name: '群昵称', groupKey: 'group:20001' });
  const line = formatPersonLine(getPerson(db, '7777'), { scope: 'group' });
  assert.ok(line.includes('群昵称'));
  assert.ok(!line.includes('私聊昵称'));
  assert.ok(!line.includes('private:'));
});

console.log(`people/cross-group replay: ${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('全部通过');
