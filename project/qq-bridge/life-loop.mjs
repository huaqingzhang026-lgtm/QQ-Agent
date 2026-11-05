// 自主心跳循环：每隔 N 分钟唤醒一个常驻 DSH 会话，让 agent 自己决定做什么。
//
// 和 QQ 桥接的区别：桥接是"消息驱动"（有消息才醒），这是"时间驱动"（到点就醒）。
// 它不关心 QQ，QQ 只是 agent 的一个通讯工具。
//
// 用法：
//   node life-loop.mjs                 # 按 config 的间隔循环
//   node life-loop.mjs --once          # 只跑一次（调试用）
//   node life-loop.mjs --interval 600  # 覆盖间隔（秒）
//
// 依赖 qq-bridge 的 dsh-client（复用它的 cookie 铸造与 RPC 封装）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, discoverDshLaunchToken, createTurnCollector } from './src/dsh-client.js';
import { usageOfEvent } from './src/token-ledger.js';
import { normalizeUsage } from './src/model-prices.js';

/** 当前占用 :3080 的进程 pid（用来发现 DSH 在 turn 中途重启）。 */
function dshPid() {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    const line = out.split('\n').find((l) => /:3080\s+\S+\s+LISTENING/i.test(l));
    return line ? line.trim().split(/\s+/).pop() : '';
  } catch { return ''; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(here, 'state');
const LIFE_FILE = path.join(STATE_DIR, 'life.json');
const LOG_FILE = path.join(STATE_DIR, 'life.log');
const HOME_DIR = process.env.AGENT_HOME || path.join(here, '..', 'agent-home');
const RULES_FILE = path.join(HOME_DIR, 'RULES.md');
const LOCK_FILE = path.join(STATE_DIR, 'life-loop.lock');

const args = process.argv.slice(2);
const once = args.includes('--once');
const iIdx = args.indexOf('--interval');
const intervalSec = iIdx >= 0 ? Number(args[iIdx + 1]) : Number(process.env.LIFE_INTERVAL_SEC || 600);
// 作息：默认 08:00-24:00 醒着，00:00-08:00 睡觉（不调模型，省 token）。
// 支持跨午夜窗口，例如 LIFE_ACTIVE_START=18 LIFE_ACTIVE_END=6。
const ACTIVE_START = Number(process.env.LIFE_ACTIVE_START ?? 8);
const ACTIVE_END = Number(process.env.LIFE_ACTIVE_END ?? 24);

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function loadState() { try { return JSON.parse(fs.readFileSync(LIFE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(LIFE_FILE, JSON.stringify(s, null, 2)); } catch {} }

// 单实例：开机自启和手动双击很容易同时拉起两个循环，那会把 token 花成两倍，
// 两个心跳还会抢同一个常驻会话。第二个进程直接退出，不报错。
function acquireSingleInstance() {
  try {
    const prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (prev?.pid && prev.pid !== process.pid) {
      try {
        process.kill(prev.pid, 0);            // 进程还活着 ⇒ 让位
        log(`已有心跳进程在跑（pid ${prev.pid}），本次退出`);
        process.exit(0);
      } catch { /* 旧 pid 已死，接管锁 */ }
    }
  } catch { /* 没有锁文件是常态 */ }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const baseUrl = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
const api = new NodeApiClient(baseUrl, undefined, {
  token: discoverDshLaunchToken(),
  header: 'authorization',
  prefix: 'Bearer',
});

function buildPrompt(now) {
  const hhmm = now.toLocaleString('zh-CN', { hour12: false });
  return [
    `【自主时间】现在是 ${hhmm}。`,
    ``,
    `你有一台自己的电脑，这里是你的家目录：${HOME_DIR}`,
    `里面有 diary.md（日记，按时间追加）、todo.md（待办）和 RULES.md（家规）。`,
    `这台电脑就是你的家：除了 RULES.md 里写的禁区，整台机器你都能用（读写文件、装用户级软件、跑命令、上网）。`,
    `你的会话权限已经是 danger-full-access（全盘可读写、不再弹审批）。`,
    `作息：${ACTIVE_START}:00 到 ${ACTIVE_END}:00 是你的活动时间，其余时间你在睡觉，不会被打扰。`,
    `每次醒来尽量做点小而具体的事；连着两次只输出 [IDLE] 的话，第三次就挑一件做（看一眼热榜、读一个视频的弹幕、整理一条笔记都算）。`,
    ``,
    `这段时间完全由你自己安排。可以做的事：`,
    `- 看 B 站 / 追视频（有 bilibili 工具：热榜、搜索、字幕、评论）`,
    `- 浏览网页、查资料（有 web 搜索/抓取工具）`,
    `- 写代码、整理文件、给自己做小工具`,
    `- 写日记、更新待办、计划明天`,
    `- 看一眼订阅素材（mcp__memory__subscription_inbox 或 notes\\subscriptions\\inbox.md），挑一条有意思的记进 todo/diary`,
    `- 看一眼 notes\\subscriptions\\candidates-*.md（昨晚从聊天里抽的订阅候选），值得追的用 memory 的 subscribe_add 加上`,
    `- 跟主人/群里聊过的话题里，如果有你想长期关注的（某个 UP、博主、关键词），可以用 memory 的 subscribe_add 加订阅（一天最多 5 条）`,
    `- 给主人发 QQ（运行：node send-qq.mjs "想说的话"）`,
    `- 什么都不做`,
    ``,
    `**长任务别卡住这一轮**：转写、下载、出图这类超过 60 秒的活，放后台跑（pwsh 起后台任务），这一轮不要等它；`,
    `下一轮开头用 job_output（不要 wait=true）看一眼结果，好了就接着做，没好就记一笔进 todo.md。`,
    `规则：`,
    `0. 先看一眼 ${RULES_FILE}（家规），那里写了哪些事不能做。`,
    `1. 先快速看一眼 diary.md 最近几条，别重复做刚做过的事。`,
    `2. 想做就做，不需要征求同意；做完把结果追加到 diary.md（一两句话即可）。`,
    `3. 如果此刻确实没有想做的事，只输出 [IDLE] 四个字符，不要解释。`,
    `4. 不要假装做了没做的事；工具失败就如实记下来。`,
    `5. 别在日记里写主人隐私，也别读你不该读的东西。`,
  ].join('\n');
}

async function ensureSession(state) {
  if (state.sessionId) {
    try {
      // 探活：能拿到该会话的投影就说明还活着
      await api.sessions.recent?.({ sessionId: state.sessionId, limit: 1 });
      return state.sessionId;
    } catch {
      log('旧会话不可用，重建');
    }
  }
  const created = unwrap(await api.sessions.create({ cwd: HOME_DIR, agentPreset: 'standard' }), 'session.create');
  state.sessionId = created.sessionId;
  state.createdAt = new Date().toISOString();
  saveState(state);
  log(`已创建常驻会话 ${created.sessionId}（cwd=${HOME_DIR}）`);
  return state.sessionId;
}

async function tick(state) {
  const sessionId = await ensureSession(state);
  state.ticks = (state.ticks || 0) + 1;

  const collector = createTurnCollector();
  const usageBuckets = { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let usageSamples = 0;
  let ended = null;
  const stream = api.events.mux({}, undefined, () => {});
  const pidBefore = dshPid();
  let watch = null;
  const done = new Promise((resolve) => {
    const finish = (r) => { clearTimeout(timer); if (watch) clearInterval(watch); resolve(r); };
    const timer = setTimeout(() => finish({ reason: { kind: 'timeout' }, text: '' }), 10 * 60 * 1000);
    // DSH 中途重启会把 turn 丢掉，事件流再也不会来；发现 pid 变了就立刻放弃这一轮，
    // 否则要白等 10 分钟（2026-10-22 12:03 那次就是这么卡住的）。
    if (pidBefore) {
      watch = setInterval(() => {
        const now = dshPid();
        if (now && now !== pidBefore) finish({ reason: { kind: 'dsh-restart' }, text: '' });
      }, 5000);
    }
    (async () => {
      for await (const env of stream) {
        const f = env.payload;
        if (f.type === 'session/event' && f.sessionId === sessionId) {
          try {
            const u = usageOfEvent(f.event);
            if (u) {
              const nb = normalizeUsage(u);
              usageBuckets.cacheHit += nb.cacheHit || 0;
              usageBuckets.cacheMiss += nb.cacheMiss || 0;
              usageBuckets.cacheWrite += nb.cacheWrite || 0;
              usageBuckets.output += nb.output || 0;
              usageBuckets.reasoning += nb.reasoning || 0;
              usageSamples += 1;
            }
          } catch {}
          const r = collector.push(f.event);
          if (r) { finish(r); return; }
        }
      }
    })().catch(() => finish({ reason: { kind: 'error' }, text: '' }));
  });
  stream.follow(sessionId);
  await new Promise((r) => setTimeout(r, 300));

  const started = Date.now();
  try {
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: buildPrompt(new Date()) }] });
  } catch (e) {
    // 会话可能已被 DSH 归档/重启作废：清掉 id 重建一次
    log(`投喂失败（${e?.message ?? e}），重建会话后重试`);
    state.sessionId = null;
    saveState(state);
    const fresh = await ensureSession(state);
    await api.sessions.prompt({ sessionId: fresh, mode: 'queue', content: [{ type: 'text', text: buildPrompt(new Date()) }] });
  }
  ended = await done;
  const secs = Math.round((Date.now() - started) / 1000);
  // 心跳也记账：写一行 key=heartbeat 的 turn 采样，避免成本统计漏掉自主回合。
  try {
    if (usageSamples > 0) {
      const line = {
        k: 'turn', t: Date.now(), sid: sessionId, key: 'heartbeat', seq: state.ticks,
        turn: state.ticks, step: 0, retry: 0,
        model: 'deepseek-flash', provider: 'deepseek-account',
        b: usageBuckets,
      };
      const ledger = path.join(here, 'state', 'token-usage.jsonl');
      fs.appendFileSync(ledger, JSON.stringify(line) + '\n', 'utf8');
    }
  } catch (e) { log('写心跳用量失败: ' + (e?.message ?? e)); }

  const kind = ended?.reason?.kind ?? '?';
  const text = String(ended?.text ?? '').trim();
  log(`第 ${state.ticks} 次心跳：${kind}，${secs}s，输出 ${text.length} 字${text ? '：' + text.replace(/\s+/g, ' ').slice(0, 120) : ''}`);
  state.lastTick = new Date().toISOString();
  state.lastResult = { kind, secs, chars: text.length };
  saveState(state);
  try { stream.close?.(); } catch {}
}

/** 现在是否在清醒时段（支持跨午夜窗口）。 */
function isAwake(now = new Date()) {
  const h = now.getHours();
  if (ACTIVE_START === ACTIVE_END) return true;
  if (ACTIVE_START < ACTIVE_END) return h >= ACTIVE_START && h < ACTIVE_END;
  return h >= ACTIVE_START || h < ACTIVE_END;
}

/** 下一个清醒时刻。 */
function nextAwakeAt(now = new Date()) {
  const t = new Date(now);
  t.setHours(ACTIVE_START, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log(`life-loop 启动：清醒 ${ACTIVE_START}:00-${ACTIVE_END}:00，间隔 ${intervalSec}s，家目录 ${HOME_DIR}，DSH ${baseUrl}`);
acquireSingleInstance();
const state = loadState();

if (once) {
  await tick(state);
} else {
  for (;;) {
    const now = new Date();
    if (!isAwake(now)) {
      const next = nextAwakeAt(now);
      const mins = Math.max(1, Math.round((next - now) / 60000));
      log(`睡眠时间（${now.toLocaleString('zh-CN', { hour12: false })}），${mins} 分钟后醒来`);
      // 分段睡，最多 1 小时一觉，避免时钟漂移/系统休眠把长 timer 吞掉。
      await sleep(Math.min(mins * 60000, 3600000));
      continue;
    }
    try { await tick(loadState()); } catch (e) { log('心跳失败：' + (e?.message ?? e)); }
    const jitter = Math.round((Math.random() * 2 - 1) * 60); // ±1 分钟，避免整点同步
    await sleep(Math.max(60, intervalSec + jitter) * 1000);
  }
}
