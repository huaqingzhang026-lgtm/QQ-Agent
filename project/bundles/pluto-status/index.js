// Pluto 状态看板 · 宿主半
//
// 只做两件事：
//   1. 从 qq-bridge/state/*.json 聚合一份只读快照；
//   2. 用 webServer 注册 GET /pluto/status，返回 JSON 给客户端半 fetch。
//
// 为什么不把数据塞进 session projection：这些是桥接进程的状态文件，和 DSH 会话无关，
// 走同源 HTTP 是最短路径，且不会给会话日志写入任何东西（本插件全程只读）。
//
// 只读承诺：本文件不写任何文件；路由只响应 GET。
import fs from 'node:fs';
import path from 'node:path';

export const name = 'pluto-status';
export const inject = ['webServer', 'configEditor'];

const ROUTE_PATH = '/pluto/status';
const MODE_ROUTE_PATH = '/pluto/mode';
const CACHE_TTL_MS = 5000;

// qq-mode-console 的 Config 允许这 5 个值（见该插件 lib/index.js 的 QqModeSchema）。
const QQ_MODES = ['chat', 'closed-agent', 'reserved', 'reserved2', 'simulation'];
const MODE_ENTRY_ID = 'qq-mode';

/** 找到 qq-mode 那个 loader entry；命名空间必须与 entry id 同名。 */
function modeEntry(ctx) {
  try {
    return ctx.configEditor.entries().find((row) => row?.options?.id === MODE_ENTRY_ID);
  } catch {
    return undefined;
  }
}

function readMode(ctx) {
  const entry = modeEntry(ctx);
  if (!entry) return { available: false, reason: `找不到 loader entry "${MODE_ENTRY_ID}"` };
  try {
    const configuration = ctx.configEditor.configuration();
    const row = configuration.find((c) => c?.entry === entry || c?.entry?.options?.id === MODE_ENTRY_ID);
    const current = row?.override ?? {};
    const inherited = row?.inherited ?? {};
    const mode = current.mode ?? inherited.mode ?? null;
    const ownerQQ = current.ownerQQ ?? inherited.ownerQQ ?? '';
    return { available: true, mode, ownerQQ, modes: QQ_MODES, entryId: MODE_ENTRY_ID };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
}

async function writeMode(ctx, nextMode) {
  const entry = modeEntry(ctx);
  if (!entry) throw new Error(`找不到 loader entry "${MODE_ENTRY_ID}"`);
  const mode = String(nextMode ?? '');
  if (!QQ_MODES.includes(mode)) throw new Error(`mode 必须是 ${QQ_MODES.join(' / ')}`);
  await ctx.configEditor.edit(entry, (current) => ({ ...current, mode }));
  return readMode(ctx);
}

/** 工作区根：DSH 由 run-dsh.cmd 以 cd /d %WS% 启动，因此 cwd 就是工作区。 */
function resolveStateDir() {
  const candidates = [
    path.resolve(process.cwd(), 'qq-bridge', 'state'),
    path.resolve(process.cwd(), '..', 'qq-bridge', 'state'),
  ];
  if (process.env.DSH_HOME) {
    candidates.push(path.resolve(process.env.DSH_HOME, '..', 'qq-bridge', 'state'));
  }
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {}
  }
  return undefined;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 每会话的厌烦度/冷落，字段名随桥接版本可能缺失，全部按可选处理。 */
function conversationSummary(key, conv) {
  if (!conv || typeof conv !== 'object') return { key };
  const wake = conv.wakeConfig ?? {};
  const annoyance = conv.annoyance && typeof conv.annoyance === 'object' ? conv.annoyance : {};
  const annoyanceTop = Object.entries(annoyance)
    .map(([uin, v]) => ({ uin, score: Number(v?.score ?? 0), name: v?.name }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const muted = conv.mutedUsers && typeof conv.mutedUsers === 'object'
    ? Object.keys(conv.mutedUsers).length
    : 0;
  return {
    key,
    mode: wake.mode,
    infinite: wake.infinite,
    unread: Array.isArray(conv.unread) ? conv.unread.length : 0,
    wakeCount: wake.wakeCount,
    lastWakeAt: wake.lastWakeAt ?? null,
    lastWakeReason: conv.lastWakeReason ?? null,
    lastAiReplyAt: conv.lastAiReplyAt ?? null,
    lastActionAt: conv.lastActionAt ?? null,
    recentMessages: Array.isArray(conv.recentMessages) ? conv.recentMessages.length : 0,
    annoyanceTop,
    muted,
  };
}

function summarizeTokens(stateDir, now) {
  const file = path.join(stateDir, 'token-usage.jsonl');
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  let todayCalls = 0;
  let input = 0;
  let output = 0;
  let byModel = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { available: false };
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row.t !== 'number' || row.t < startOfDay.getTime()) continue;
    todayCalls++;
    const b = row.b ?? {};
    const inTok = (b.cacheMiss ?? 0) + (b.cacheHit ?? 0) + (b.cacheWrite ?? 0);
    input += inTok;
    output += b.output ?? 0;
    const model = row.model ?? 'unknown';
    byModel[model] ??= { calls: 0, input: 0, output: 0 };
    byModel[model].calls++;
    byModel[model].input += inTok;
    byModel[model].output += b.output ?? 0;
  }
  return { available: true, todayCalls, input, output, byModel };
}

function buildSnapshot(ctx) {
  const stateDir = resolveStateDir();
  const now = Date.now();
  if (!stateDir) {
    return { ok: false, error: '找不到 qq-bridge/state 目录', generatedAt: now };
  }

  const social = readJson(path.join(stateDir, 'social-v2.json')) ?? {};
  const conversations = social.conversations && typeof social.conversations === 'object'
    ? Object.entries(social.conversations).map(([key, conv]) => conversationSummary(key, conv))
    : [];

  const affinityRaw = readJson(path.join(stateDir, 'affinity.json')) ?? {};
  const affinityTop = Object.entries(affinityRaw)
    .map(([uin, v]) => ({
      uin,
      score: Number(v?.score ?? 0),
      interactions: v?.interactions ?? 0,
      lastSeen: v?.lastSeen ?? null,
      notes: Array.isArray(v?.notes) ? v.notes.length : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const imageSends = readJson(path.join(stateDir, 'image-sends.json')) ?? {};
  const imageItems = Array.isArray(imageSends.items) ? imageSends.items : [];
  const dayAgo = now - 24 * 3600 * 1000;
  const imageByConversation = {};
  for (const item of imageItems) {
    const key = String(item?.key ?? 'unknown');
    imageByConversation[key] = (imageByConversation[key] ?? 0) + 1;
  }
  const images = {
    windowItems: imageItems.length,
    last24h: imageItems.filter((i) => Number(i?.at) >= dayAgo).length,
    byConversation: imageByConversation,
    resetAt: imageSends.resetAt ?? null,
  };

  const live = readJson(path.join(stateDir, 'live-watch.json')) ?? {};
  const sessions = readJson(path.join(stateDir, 'sessions.json')) ?? {};

  return {
    ok: true,
    generatedAt: now,
    stateDir,
    bridge: { paused: social.paused === true, revision: social.revision, schemaVersion: social.schemaVersion },
    conversations,
    affinityTop,
    images,
    live: {
      name: live.name ?? null,
      nick: live.nick ?? null,
      roomId: live.roomId ?? null,
      lastStatus: live.lastStatus ?? null,
      lastLiveAt: live.lastLiveAt ?? null,
      lastNotifiedAt: live.lastNotifiedAt ?? null,
    },
    sessions: sessions.sessions ?? {},
    tokens: summarizeTokens(stateDir, now),
    mode: readMode(ctx),
  };
}

let cache = { at: 0, body: undefined };

function snapshotCached(ctx) {
  const now = Date.now();
  if (cache.body && now - cache.at < CACHE_TTL_MS) return cache.body;
  let body;
  try {
    body = buildSnapshot(ctx);
  } catch (error) {
    body = { ok: false, error: String(error?.message ?? error), generatedAt: now };
  }
  cache = { at: now, body };
  return body;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** 只接受小 JSON 体；超限直接失败，避免被当成通用文件上传口。 */
async function readJsonBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'read-only' }));
        return;
      }
      const body = JSON.stringify(snapshotCached(ctx));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  }));

  // qq-mode 的写入口。
  //
  // 为什么需要它：qq-mode-console 只有 host 半（作者刻意不做 client 半），
  // 0.2.0 的设置命名空间由 loader entry 推导，本插件用 configEditor 直接改那条
  // entry 的 config —— 与「设置页改名」是同一条持久化路径，桥接下一次轮询即可见。
  //
  // 信任边界：只绑本机、只接受 JSON、只允许 5 个枚举值。本机进程本来就能直接
  // 改 state/ 与 profile 文件，这个入口没有扩大攻击面。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MODE_ROUTE_PATH,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...readMode(ctx) });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'use GET or POST' });
        return;
      }
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await writeMode(ctx, body?.mode);
        cache = { at: 0, body: undefined };
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));
}
