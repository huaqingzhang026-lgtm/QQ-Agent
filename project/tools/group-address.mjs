// 学习群里的"称呼"：谁叫什么（sender 昵称、@提到的名字、X哥/老X/小X 这类）。
// 产物：agent-home\notes\群称呼.md（memory_search 可查）+ state\group-address.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePersonNames } from '../qq-bridge/src/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const OUT_MD = path.join(ROOT, 'agent-home', 'notes', '群称呼.md');
const OUT_JSON = path.join(STATE, 'group-address.json');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const SELF = new Set(['pluto.', 'pluto', '小鲸鱼', 'deepseek']);

const social = readJson(path.join(STATE, 'social-v2.json'), {});
const groups = Object.keys(social.conversations ?? {}).filter((k) => k.startsWith('group:'));

const byUser = new Map();   // userId -> { name, n }
const byUserGroupNames = new Map(); // userId -> { groupKey: name }
const byName = new Map();   // 称呼 -> { n, userIds:Set, examples:[] }

const addName = (name, userId, example, opts = {}) => {
  const strict = opts.strict === true;
  let key = String(name ?? '').trim();
  if (strict) {
    key = key.replace(/^[和跟与的]+/, '');
    // 切词来源才过滤碎词：带动词/代词/语气词的（「牢框在努」「公主很生气」）
    if (/[在是了的地得也都很就会要你我他她们吗呢吧啊]/.test(key)) return;
    if (key.length > 4) return;
  }
  if (key.length > 14) return;
  if (!key || key.length > 14) return;
  if (SELF.has(key.toLowerCase())) return;
  if (/^[0-9]+$/.test(key)) return;
  if (/^(全体成员|所有人|all)$/i.test(key)) return;
  const cur = byName.get(key) ?? { n: 0, userIds: new Set(), examples: [] };
  cur.n += 1;
  if (userId) cur.userIds.add(String(userId));
  if (example && cur.examples.length < 2) cur.examples.push(String(example).slice(0, 50));
  byName.set(key, cur);
};

const SUFFIX = /([\u4e00-\u9fa5A-Za-z0-9]{1,6})(哥|姐|总|老师|师傅|老板|叔|姨|妹|宝|神|酱)/g;
const PREFIX = /([老小阿牢大二三四五])([\u4e00-\u9fa5]{1,3})/g;
const HONOR = /(公主|太子|王爷|大人|陛下|大佬|群主|楼主|萌新|老婆|老公|宝宝|宝贝|大爹)/g;

for (const g of groups) {
  const atMap = social.conversations[g].atNameMap ?? {};
  for (const [qq, name] of Object.entries(atMap)) {
    addName(String(name), String(qq), '', { source: 'atmap' });
    const m = byUserGroupNames.get(String(qq)) || {}; m[g] = String(name); byUserGroupNames.set(String(qq), m);
  }
  for (const m of social.conversations[g].recentMessages ?? []) {
    if (m.isSelf) continue;
    const t = String(m.text ?? '');
    const uid = String(m.userId ?? '');
    const sender = String(m.sender ?? '').trim();
    if (sender && sender !== '私聊' && uid) {
      const cur = byUser.get(uid) ?? { name: sender, n: 0 };
      cur.n += 1; cur.name = sender;
      byUser.set(uid, cur);
      addName(sender, uid, t);
      const gm = byUserGroupNames.get(uid) || {}; gm[g] = sender; byUserGroupNames.set(uid, gm);
    }
    for (const mm of t.matchAll(/@([^\s@,，。:：]{1,12})/g)) {
      const name = mm[1].replace(/[\[\(（].*$/, '');
      addName(name, '', t);
    }
    for (const mm of t.matchAll(SUFFIX)) addName(mm[1] + mm[2], '', t, { strict: true });
    for (const mm of t.matchAll(PREFIX)) {
      const name = mm[1] + mm[2];
      if (['老天', '小时', '小说', '小心', '老大', '小区', '大不', '二不', '三不', '五不'].includes(name)) continue;
      addName(name, '', t, { strict: true });
    }
    for (const mm of t.matchAll(HONOR)) addName(mm[1], '', t, { strict: true });
  }
}

// 本地模型抽外号（正则抓不到的那种）
let llmNames = [];
if (!process.argv.includes('--no-local')) {
  try {
    const lines = [];
    for (const g of groups) {
      for (const m of social.conversations[g].recentMessages ?? []) {
        if (m.isSelf) continue;
        const t2 = String(m.text ?? '').trim();
        if (t2.length >= 2) lines.push(`${m.sender ?? '群友'}：${t2}`);
      }
    }
    const corpus = lines.slice(-120).join('\n').slice(0, 6000);
    const res = await fetch('http://127.0.0.1:11435/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: 'qwen2.5-3b-instruct',
        messages: [
          { role: 'system', content: '你是群聊观察员。从记录里找出"群友互相怎么称呼"的**外号/昵称**（例如 牢框、公主、示例群友甲、猫食、老张）。只输出 JSON：{"names":["..."]}；不要人名全称、不要普通名词、没有就给空数组。' },
          { role: 'user', content: corpus },
        ],
        temperature: 0.3, max_tokens: 300, stream: false, response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      const j = JSON.parse(await res.text());
      const raw = String(j.choices?.[0]?.message?.content ?? '');
      const mm = raw.match(/\{[\s\S]*\}/);
      const obj = mm ? JSON.parse(mm[0]) : null;
      llmNames = Array.isArray(obj?.names) ? obj.names.map(String) : [];
    }
  } catch {}
}
for (const n of llmNames) addName(n, '', '模型识别');

// 用群成员列表把外号绑到 QQ（外号和昵称不完全一样时，靠包含关系猜）
async function fetchMembers(groupId) {
  const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
  const base = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = cfg.snowluma?.accessToken ?? '';
  const res = await fetch(base + '/get_group_member_list', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ group_id: Number(groupId) }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  return Array.isArray(j.data) ? j.data : [];
}

const MEMBER_CACHE = path.join(STATE, 'group-members.json');
let members = [];
try {
  const cache = readJson(MEMBER_CACHE, {});
  const age = Date.now() - Number(cache.at ?? 0);
  if (age < 24 * 3600e3 && Array.isArray(cache.list) && cache.list.length) members = cache.list;
} catch {}
if (!members.length) {
  for (const g of groups) {
    try {
      const list = await fetchMembers(g.replace('group:', ''));
      for (const m of list) members.push({ qq: String(m.user_id ?? ''), name: String(m.card || m.nickname || '') });
    } catch {}
  }
  if (members.length) fs.writeFileSync(MEMBER_CACHE, JSON.stringify({ at: Date.now(), list: members }, null, 2) + '\n', 'utf8');
}

// 名字里包含外号 / 外号包含名字 的成员，唯一才绑定
for (const [name, v] of byName.entries()) {
  if (v.userIds.size > 0) continue;
  const cands = members.filter((m) => m.name && (m.name.includes(name) || (name.length >= 2 && name.includes(m.name) && m.name.length >= 2)));
  if (cands.length === 1) v.userIds.add(cands[0].qq);
}

// 手工绑定覆盖：state/address-overrides.json = { "牢框": "123456" }
try {
  const ov = readJson(path.join(STATE, 'address-overrides.json'), {});
  for (const [name, qq] of Object.entries(ov)) {
    const v = byName.get(name);
    if (v && qq) v.userIds.add(String(qq));
  }
} catch {}

// 把每个群的昵称按 QQ 合并进 people，不覆盖其他群的叫法；QQ 是跨群主键。
for (const [uid, namesByGroup] of byUserGroupNames.entries()) {
  try { mergePersonNames({ qq: uid, names: namesByGroup, lastSeenAt: Date.now() }); } catch {}
}

const names = [...byName.entries()]
  .filter(([, v]) => v.n >= 2 || (v.examples[0] === '模型识别'))
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, 30)
  .map(([name, v]) => ({ name, count: v.n, userIds: [...v.userIds].slice(0, 3), examples: v.examples }));

const users = [...byUser.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, 30)
  .map(([uid, v]) => ({ userId: uid, name: v.name, messages: v.n }));

fs.writeFileSync(OUT_JSON, `${JSON.stringify({ updatedAt: new Date().toISOString(), groups: groups.length, names, users }, null, 2)}\n`, 'utf8');

const md = [
  '# 群里的称呼',
  '',
  `来源：${groups.length} 个群，最近 100 条/群；出现 ≥2 次的才记。`,
  '',
  '## 怎么叫这些人',
  ...(names.length ? names.map((x) => `- **${x.name}**${x.userIds.length ? '（QQ ' + x.userIds.join(' / ') + '）' : ''}　${x.count} 次${x.examples.length ? '　例：' + x.examples[0] : ''}`) : ['（还没攒到）']),
  '',
  '## 谁是谁（昵称 → QQ）',
  ...(users.length ? users.map((u) => `- ${u.name}（${u.userId}，${u.messages} 条）`) : ['（还没攒到）']),
  '',
  '> 用这些叫法称呼群友；没把握就用「你」，别叫人家 QQ 号。别人被叫外号时跟着叫，比自己发明称呼安全。',
  '',
].join('\n');
fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, md, 'utf8');

console.log(`学会 ${names.length} 个称呼、${users.length} 个昵称：${names.slice(0, 8).map((x) => x.name).join('、') || '（还没攒到）'}`);
