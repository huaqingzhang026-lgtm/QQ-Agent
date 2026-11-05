// 人物记忆（按 QQ 号全局存储，不按群割裂）——S2/S6 的一部分。
//
// 现状问题（audit 已记录）：`memberImpressions` 存在**会话状态**里，同一个人在
// A 群和 B 群会有两份互不相干的印象；昵称也各群一份。
//
// 本模块把它改成 `state/people.json`：以 QQ 号为键，记录
//   · names：在哪些群被叫什么（群 → 昵称）
//   · impressions：跨群共享的印象条目（带来源群与时间）
//   · lastSeenAt：最后一次出现
//
// 约束：
//   · 只由桥接写入（与 state-ownership.md 一致）；
//   · 原子写（临时文件 + 替换）；
//   · 损坏时返回空表而不是抛错，避免把整个记忆读挂。

import fs from 'node:fs';
import path from 'node:path';

const MAX_IMPRESSIONS = 30;

function emptyDb() {
  return { version: 1, people: {} };
}

export function loadPeople(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object' || typeof raw.people !== 'object') return emptyDb();
    return { version: 1, people: raw.people };
  } catch {
    return emptyDb();
  }
}

export function savePeople(file, db) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.people.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, people: db.people }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

function ensurePerson(db, qq) {
  const id = String(qq ?? '').trim();
  if (!/^\d{4,}$/.test(id)) return null;
  db.people[id] = db.people[id] ?? { qq: id, names: {}, impressions: [], lastSeenAt: 0 };
  const p = db.people[id];
  if (!p.names || typeof p.names !== 'object') p.names = {};
  if (!Array.isArray(p.impressions)) p.impressions = [];
  return p;
}

/** 记录"这个 QQ 在某个群叫什么、什么时候出现过"。 */
export function touchPerson(db, { qq, name, groupKey, at = Date.now() }) {
  const p = ensurePerson(db, qq);
  if (!p) return null;
  if (name && groupKey) p.names[groupKey] = String(name).slice(0, 40);
  p.lastSeenAt = Math.max(Number(p.lastSeenAt) || 0, at);
  return p;
}

/** 追加一条印象（跨群共享）。 */
export function addImpression(db, { qq, text, groupKey, source = 'ai', at = Date.now() }) {
  const scope = String(groupKey ?? '').startsWith('private:') ? 'private' : (groupKey ? 'group' : 'unknown');
  const p = ensurePerson(db, qq);
  if (!p) return null;
  const t = String(text ?? '').trim().slice(0, 300);
  if (!t) return p;
  // 同文去重（同一句印象不在群里重复堆）
  if (p.impressions.some((x) => x.text === t)) return p;
  p.impressions.push({ text: t, at, group: groupKey ?? '', source, scope });
  if (p.impressions.length > MAX_IMPRESSIONS) p.impressions = p.impressions.slice(-MAX_IMPRESSIONS);
  return p;
}

/** 读出一个人；不存在返回 null。 */
export function getPerson(db, qq) {
  return db.people[String(qq ?? '')] ?? null;
}

/** 最近 N 条印象（新的在前）。 */
export function recentImpressions(person, limit = 5) {
  if (!person || !Array.isArray(person.impressions)) return [];
  return person.impressions.slice(-Math.max(1, limit)).reverse();
}

/**
 * 一行式摘要，供 prompt 使用：
 *   `示例群友甲（QQ 10002）在 2 个群都出现过；印象：爱问实验细节、笑点低`
 */
export function formatPersonLine(person, { impressionLimit = 4, scope = null } = {}) {
  if (!person) return '';
  // 昵称也按 scope 过滤：群聊里不出现"只在私聊出现过的昵称/私聊 key"（F01）。
  const names = Object.entries(person.names ?? {}).filter(([g]) => {
    if (!scope) return true;
    const isPrivate = String(g).startsWith('private:');
    if (scope === 'private') return true;
    return !isPrivate;
  });
  const nameText = names.length
    ? names.map(([g, n]) => `${n}@${g.replace(/^group:/, '群')}`).join(' / ')
    : '（没有昵称记录）';
  // 记忆隔离：群聊只看 group 来源的印象，私聊可以看全部；无 scope 标记的旧数据按 unknown 处理（仅私聊可见）。
  const allowed = (x) => {
    if (!scope) return true;
    const s = x.scope ?? (String(x.group ?? '').startsWith('private:') ? 'private' : (x.group ? 'group' : 'unknown'));
    if (scope === 'private') return true;
    return s === 'group';
  };
  const imps = recentImpressions(person, 50).filter(allowed).slice(0, impressionLimit).map((x) => x.text);
  const seen = Number(person.lastSeenAt) ? new Date(Number(person.lastSeenAt)).toLocaleString('zh-CN', { hour12: false }) : '未知';
  const bits = [`【这个人】${nameText}`, `QQ ${person.qq}`, `最近出现 ${seen}`];
  if (imps.length) bits.push(`印象：${imps.join('；')}`);
  return bits.join('；');
}

/**
 * 兼容迁移：把旧会话里的 memberImpressions 合并进全局表。
 * 旧值可能是字符串或对象，按"目标名"作键；无 QQ 可对时不硬塞，交给 caller 决定。
 */
export function mergeLegacyImpressions(db, { conversationKey, impressions }) {
  if (!impressions || typeof impressions !== 'object') return 0;
  let merged = 0;
  for (const [target, value] of Object.entries(impressions)) {
    // 只有键本身是 QQ 号时才迁移（旧数据里 target 也可能是昵称）
    if (!/^\d{4,}$/.test(String(target))) continue;
    const text = typeof value === 'string' ? value : (value?.text ?? value?.note ?? '');
    if (text) {
      addImpression(db, { qq: target, text, groupKey: conversationKey, source: 'legacy' });
      merged += 1;
    }
  }
  return merged;
}
