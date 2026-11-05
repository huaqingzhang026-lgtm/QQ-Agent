// 跨会话记忆 · 原生 Host 插件
//
// 原实现是 memory-mcp/server.mjs（独立 stdio 进程，每次调用现读现算）。这里
// 逐段搬过来，保持不变的有：数据源集合、相关度打分、scope 令牌校验、订阅配额。
// 变的只有承载方式：从 stdio 子进程变成 DSH 进程内的原生 tool 注册。
//
// 工具名保留 mcp__memory__ 前缀，理由见 cordis.patch.yml。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'pluto-memory';
export const inject = ['tools'];

/** DSH 由 run-dsh.cmd 以工作区为 cwd 启动；其它 cwd 时按候选目录兜底。 */
function resolveWorkspace() {
  const candidates = [process.cwd(), path.resolve(process.cwd(), '..')];
  if (process.env.DSH_HOME) candidates.push(path.resolve(process.env.DSH_HOME, '..'));
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'agent-home')).isDirectory()) return dir;
    } catch {}
  }
  return process.cwd();
}

const ROOT = resolveWorkspace();
const HOME = path.join(ROOT, 'agent-home');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const CONF = path.join(ROOT, 'subscriptions.json');
const ADDS = path.join(STATE, 'subscribe-adds.json');
const SCOPE_SECRET_FILE = process.env.MEMORY_SCOPE_SECRET_FILE || path.join(STATE, 'memory-scope.key');
const SCOPE_SHARE_GROUPS = String(process.env.MEMORY_SCOPE_SHARE_GROUPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// 与 memory-mcp 共用同一个 scope 模块：桥接签发的【记忆令牌】必须在这里也能验。
const scopeModule = await import(pathToFileURL(path.join(ROOT, 'qq-bridge', 'src', 'memory-scope.js')).href);
const { ensureSecret, verifyScopeToken, allowedScopes, isRecordVisible } = scopeModule;
const SCOPE_SECRET = ensureSecret(SCOPE_SECRET_FILE);

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
};
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'frames' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (/\.(md|txt)$/i.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function records() {
  const out = [];
  const ownerQq = String((readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {}).ownerQQ) ?? '');

  // 1) 家目录里的文字（日记/待办/笔记/转写）
  for (const file of walk(HOME)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(ROOT, file);
    const relPosix = String(rel).split(path.sep).join('/');
    // 日记/反馈/订阅/图片属于"她和主人之间"的私有材料：群聊 token 不可读（F01）。
    const isPrivateNote = /agent-home\/notes\/(daily|feedback|subscriptions|images)\//.test(relPosix);
    const fileScope = isPrivateNote && ownerQq ? 'private:' + ownerQq : 'shared';
    for (const block of text.split(/\n{2,}/)) {
      const t = block.trim();
      if (t.length < 2) continue;
      out.push({ source: 'file', where: rel, time: '', text: t, scope: fileScope });
    }
  }

  // 2) QQ 聊天记录（最近 100 条/会话）+ 对每个人的印象
  const social = readJson(path.join(STATE, 'social-v2.json'), {});
  for (const [key, conv] of Object.entries(social.conversations ?? {})) {
    for (const m of conv.recentMessages ?? []) {
      const t = String(m.text ?? m.plain ?? '').trim();
      if (!t) continue;
      out.push({ source: 'chat', where: key, time: fmtTime(m.time), ts: Number(m.time) || 0, text: `${m.sender ?? ''}: ${t}`, scope: key });
    }
    for (const [name, imp] of Object.entries(conv.memberImpressions ?? {})) {
      for (const trait of imp.traits ?? []) {
        out.push({ source: 'impression', where: `${key} ${name}`, time: fmtTime(imp.lastSeenAt), text: String(trait), scope: key });
      }
    }
  }

  // 3) 好感度记录
  const affinity = readJson(path.join(STATE, 'affinity.json'), {});
  for (const [uin, e] of Object.entries(affinity)) {
    for (const n of e.notes ?? []) out.push({ source: 'affinity', where: uin, time: '', text: String(n), scope: 'shared' });
  }

  // 4) 表情备注
  const stickers = readJson(path.join(STATE, 'stickers.json'), []);
  for (const s of Array.isArray(stickers) ? stickers : []) {
    if (s.localNote) out.push({ source: 'sticker', where: String(s.id ?? ''), time: '', text: String(s.localNote), scope: 'shared' });
  }

  return out;
}

function search(query, limit, scopeKey = '') {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const terms = [...new Set([q, ...q.split(/\s+/).filter((t) => t.length >= 2)])];
  const now = Date.now();
  const hits = [];
  const allowed = allowedScopes({ scopeKey, shareGroups: SCOPE_SHARE_GROUPS });
  for (const rec of records()) {
    if (!isRecordVisible(rec.scope, allowed)) continue;
    const hay = rec.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let idx = hay.indexOf(term);
      while (idx !== -1) { score += term === q ? 2 : 1; idx = hay.indexOf(term, idx + term.length); }
    }
    if (score === 0) continue;
    if (rec.source === 'impression' || rec.source === 'affinity') score += 1.5;
    if (rec.source === 'chat' && rec.ts && now - rec.ts < 7 * 864e5) score += 2;
    const idx = hay.indexOf(q) !== -1 ? hay.indexOf(q) : Math.max(0, hay.indexOf(terms[1] ?? q));
    const start = Math.max(0, idx - 60);
    const snippet = (start ? '…' : '') + rec.text.slice(start, start + 200).replace(/\s+/g, ' ').trim() + (rec.text.length > start + 200 ? '…' : '');
    hits.push({ score: Math.round(score * 10) / 10, source: rec.source, where: rec.where, time: rec.time, text: snippet });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, Math.min(Number(limit) || 8, 30)));
}

function stats() {
  const all = records();
  const bySource = {};
  for (const r of all) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  return { total: all.length, files: walk(HOME).length, bySource };
}

const today = () => new Date().toLocaleDateString('zh-CN');
const loadConf = () => readJson(CONF, { targets: [] });
const saveConf = (conf) => fs.writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

function subscribeList() {
  const conf = loadConf();
  return (conf.targets ?? []).map((t) => ({
    id: t.id,
    kind: t.kind,
    name: t.name ?? '',
    detail: t.kind === 'weibo_hot' ? (t.keywords ?? []).join('、') : t.kind === 'bili_dynamic' ? `uid ${t.uid}` : t.url ?? '',
  }));
}

function subscribeAdd(args) {
  const conf = loadConf();
  const kind = String(args?.kind ?? '');
  const counter = readJson(ADDS, { date: '', count: 0 });
  if (counter.date !== today()) { counter.date = today(); counter.count = 0; }
  if (counter.count >= 5) throw new Error('今天已经加了 5 条订阅了，明天再说（别把别人的兴趣当成自己的）');

  let target = null;
  if (kind === 'weibo_hot') {
    const keywords = (args?.keywords ?? []).map(String).filter(Boolean);
    if (!keywords.length) throw new Error('weibo_hot 需要 keywords');
    target = { id: `weibo-${slug(keywords.join('-'))}`, kind, keywords, ...(args?.name ? { name: String(args.name) } : {}) };
  } else if (kind === 'bili_dynamic') {
    const uid = Number(args?.uid);
    if (!uid) throw new Error('bili_dynamic 需要 uid');
    target = { id: `bili-${uid}`, kind, uid, ...(args?.name ? { name: String(args.name) } : {}) };
  } else if (kind === 'rss') {
    const url = String(args?.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new Error('rss 需要 http(s) url');
    target = { id: `rss-${slug(args?.name || new URL(url).hostname)}`, kind, url, ...(args?.name ? { name: String(args.name) } : {}) };
  } else {
    throw new Error('kind 必须是 weibo_hot / bili_dynamic / rss');
  }
  conf.targets = conf.targets ?? [];
  if (conf.targets.some((t) => t.id === target.id)) throw new Error(`已经有这个订阅了：${target.id}`);
  conf.targets.push(target);
  saveConf(conf);
  counter.count += 1;
  fs.writeFileSync(ADDS, `${JSON.stringify(counter, null, 2)}\n`, 'utf8');
  return { added: target, note: '下一次订阅检查会先建基线，不会把历史一次推出来' };
}

function subscribeRemove(args) {
  const conf = loadConf();
  const id = String(args?.id ?? '');
  const before = (conf.targets ?? []).length;
  conf.targets = (conf.targets ?? []).filter((t) => t.id !== id);
  if (conf.targets.length === before) throw new Error(`没有这个订阅：${id}`);
  saveConf(conf);
  try {
    const st = readJson(path.join(STATE, 'subscriptions-state.json'), {});
    delete st[id];
    fs.writeFileSync(path.join(STATE, 'subscriptions-state.json'), `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  } catch {}
  return { removed: id, left: conf.targets.map((t) => t.id) };
}

const HANDLERS = {
  memory_search(args) {
    const scopeKey = verifyScopeToken(SCOPE_SECRET, args?.scopeToken) || '';
    const hits = search(args?.query, args?.limit, scopeKey);
    return { ok: true, query: args?.query, count: hits.length, results: hits };
  },
  memory_stats() {
    return { ok: true, ...stats() };
  },
  subscription_inbox(args) {
    const pool = readJson(path.join(STATE, 'subscription-new.json'), { items: [] });
    const limit = Math.max(1, Math.min(Number(args?.limit) || 5, 20));
    return {
      ok: true,
      updatedAt: pool.updatedAt ?? null,
      items: (pool.items ?? []).slice(0, limit).map((x) => ({ label: x.label, title: x.title, at: x.at })),
      hint: '用你自己的话说，不要贴链接；没兴趣就别硬聊。',
    };
  },
  subscribe_list() {
    return { ok: true, targets: subscribeList() };
  },
  subscribe_add(args) {
    return { ok: true, ...subscribeAdd(args) };
  },
  subscribe_remove(args) {
    return { ok: true, ...subscribeRemove(args) };
  },
};

const TOOLS = [
  {
    name: 'mcp__memory__memory_search',
    handler: 'memory_search',
    description: '跨会话回忆：在日记、待办、笔记、转写文本、QQ 聊天记录、对每个人的印象、好感度记录、表情备注里搜关键词。想知道"以前聊过什么/我记过什么/这个人是谁"，先用它。返回按相关度排序的片段（含出处和时间）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（中文直接搜，支持空格分词）' },
        limit: { type: 'number', description: '返回条数，默认 8' },
        scopeToken: { type: 'string', description: '会话记忆令牌（唤醒提示里的【记忆令牌】）；不传只能检索公共笔记' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mcp__memory__memory_stats',
    handler: 'memory_stats',
    description: '看记忆库里都有什么：各来源条数、文件数。用于判断"我到底记得多少"。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mcp__memory__subscription_inbox',
    handler: 'subscription_inbox',
    description: '取"订阅素材"：她关注的微博热搜词 / B 站 UP 动态 / RSS 最近的新内容。冷场、被问"最近有啥新鲜事"、想主动找话题时用它拿几条，然后用你自己的话说，不要贴链接。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '取几条，默认 5' } } },
  },
  {
    name: 'mcp__memory__subscribe_list',
    handler: 'subscribe_list',
    description: '看你现在订阅了什么（微博热搜关键词 / B 站 UP / RSS）。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mcp__memory__subscribe_add',
    handler: 'subscribe_add',
    write: true,
    description: '新增一条订阅（她自己关心的东西）。来源可以是聊天里反复出现的话题、某人提到的 UP 主/博主、或者你想持续追的关键词。每天最多加 5 条，别把别人的兴趣当成自己的。kind=weibo_hot 传 keywords；kind=bili_dynamic 传 uid；kind=rss 传 url。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['weibo_hot', 'bili_dynamic', 'rss'] },
        keywords: { type: 'array', items: { type: 'string' }, description: 'weibo_hot 用' },
        uid: { type: 'number', description: 'bili_dynamic 用（UP 主 uid）' },
        url: { type: 'string', description: 'rss 用' },
        name: { type: 'string', description: '备注名' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'mcp__memory__subscribe_remove',
    handler: 'subscribe_remove',
    write: true,
    description: '取消一条订阅（id 从 subscribe_list 里拿）。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

export function apply(ctx) {
  for (const tool of TOOLS) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // 订阅写操作串行，避免配额计数互相覆盖。
      isConcurrencySafe: () => !tool.write,
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return HANDLERS[tool.handler](args ?? {});
      },
    }));
  }
}
