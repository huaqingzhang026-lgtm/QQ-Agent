// 画图 + 发图：stable-diffusion.cpp（Vulkan，用 3070 Ti）本地出图，再通过 OneBot 把图片发到指定会话。
//
// 工具：
//   generate(prompt, negative?, width?, height?, steps?, seed?) → { file, path, seconds }
//   send_image(file, key) → { messageId }   key = private:<qq> / group:<群号>，必须命中 config 白名单
//
// 只在本地跑，不花钱、不联网（模型和 sd.exe 都在 sd\ 下）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SD_DIR = path.join(ROOT, 'sd');
const BIN = path.join(SD_DIR, 'vulkan', 'sd-cli.exe');
const MODEL = path.join(SD_DIR, 'v1-5-pruned-emaonly-fp16.safetensors');
const HOME = path.join(ROOT, 'agent-home');
const OUT_DIR = path.join(HOME, 'notes', 'images');
const LOCAL_LLM = (process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:11435/v1').replace(/\/+$/, '');
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'image-calls.jsonl');

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return f; } };
const logCall = (rec) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); } catch {} };

const SD_SERVER = process.env.SD_SERVER_URL || 'http://127.0.0.1:11436';
const PROVIDER_FILE = path.join(ROOT, 'image-provider.json');

function providerCfg() {
  const cfg = readJson(PROVIDER_FILE, { provider: 'local' });
  return { provider: cfg.provider ?? 'local', ark: cfg.ark ?? null, gpt: cfg.gpt ?? null };
}

/** 火山方舟 Seedream */
/** OpenAI 兼容 Images API（gpt-image-2.5），支持参考图。 */
async function generateViaGpt(opts, gpt) {
  const size = opts.size ?? gpt.size ?? '1024x1536';
  const base = String(gpt.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '');
  let buf;
  if (opts.image) {
    const fd = new FormData();
    fd.append('model', gpt.model || 'gpt-image-2.5-flare');
    fd.append('prompt', String(opts.prompt));
    fd.append('size', size);
    fd.append('n', '1');
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(opts.image));
    if (!m) throw new Error('gpt reference must be data uri');
    fd.append('image', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'persona.png');
    const r = await fetch(base + '/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + gpt.apiKey }, body: fd, signal: AbortSignal.timeout(240000) });
    const txt = await r.text();
    if (!r.ok) throw new Error('gpt edit ' + r.status + ': ' + txt.slice(0, 200));
    const j = JSON.parse(txt); const item = j.data?.[0] || {};
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
    else if (item.url) { const ir = await fetch(item.url); buf = Buffer.from(await ir.arrayBuffer()); }
    else throw new Error('gpt no image');
  } else {
    const r = await fetch(base + '/images/generations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gpt.apiKey }, body: JSON.stringify({ model: gpt.model || 'gpt-image-2.5-flare', prompt: String(opts.prompt), size, n: 1 }), signal: AbortSignal.timeout(240000) });
    const txt = await r.text();
    if (!r.ok) throw new Error('gpt gen ' + r.status + ': ' + txt.slice(0, 200));
    const j = JSON.parse(txt); const item = j.data?.[0] || {};
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
    else if (item.url) { const ir = await fetch(item.url); buf = Buffer.from(await ir.arrayBuffer()); }
    else throw new Error('gpt no image');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(OUT_DIR, 'img-gpt-' + stamp + '.png');
  fs.writeFileSync(out, buf);
  return { file: path.basename(out), path: out, kb: Math.round(buf.length / 1024), provider: 'gpt', model: gpt.model, size };
}

async function generateViaArk(opts, ark) {
  const size = opts.size ?? ark.size ?? '1536x2048';
  const body = {
    model: ark.model ?? 'doubao-seedream-4-0-20260415',
    prompt: String(opts.prompt),
    size,
    response_format: 'url',
    watermark: false,
    ...(opts.image ? { image: opts.image } : {}),
  };
  const res = await fetch(`${ark.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3'}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ark.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ark ${res.status}: ${text.slice(0, 240)}`);
  const j = JSON.parse(text);
  const url = j.data?.[0]?.url;
  if (!url) throw new Error('ark 没有返回图片 url');
  const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!img.ok) throw new Error(`下载图片失败 HTTP ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(OUT_DIR, `img-ark-${stamp}.jpg`);
  fs.writeFileSync(out, buf);
  return { file: path.basename(out), path: out, kb: Math.round(buf.length / 1024), provider: 'ark', model: body.model, size };
}

async function generateViaServer({ prompt, negative, width = 512, height = 768, steps = 20, seed }) {
  const body = {
    prompt: String(prompt),
    negative_prompt: String(negative ?? 'lowres, bad anatomy, extra fingers, watermark, text, blurry'),
    steps: Number(steps),
    width: Number(width),
    height: Number(height),
    cfg_scale: 7,
    sampler_name: 'euler_a',
    ...(seed !== undefined ? { seed: Number(seed) } : {}),
  };
  const res = await fetch(`${SD_SERVER}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sd-server HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const b64 = j.images?.[0];
  if (!b64) throw new Error('sd-server 没有返回图片');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(OUT_DIR, `img-${stamp}.png`);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  return { file: path.basename(out), path: out, kb: Math.round(fs.statSync(out).size / 1024) };
}

// 她的固定形象：DeepSeek 小鲸鱼的二次元拟人。selfie=true 时自动拼在 prompt 前面，
// 保证每次画自己都是同一个人（发色/眼睛/鲸鱼发夹/蓝白配色）。
const CANON_NAME = 'her-canonical.png';
const SCENE_LOG = path.join(ROOT, 'qq-bridge', 'state', 'image-scenes.json');

// 场景骰子：按时段分桶，避开最近用过的，防止每次都是"窗边微笑"。
const SCENES = {
  morning: [
    'sitting on the bed just woken up, hair messy, holding a mug of hot water, soft morning light through curtains',
    'at a sunlit kitchen counter eating toast, sleepy eyes, oversized shirt',
    'on the balcony watering plants, morning sun, light cardigan, barefoot',
  ],
  afternoon: [
    'at a cafe table by the window with a laptop and iced coffee, focused, hair tied up',
    'sitting on the floor surrounded by books and notes, afternoon sun patches, pen in hand',
    'walking on a quiet street with earphones in, hands in pockets, sunlight through trees',
  ],
  evening: [
    'on a rooftop at sunset, wind in hair, looking at the city, light jacket',
    'curled on the sofa with a blanket and a game controller, warm lamp light',
    'cooking in a small kitchen, steam rising, apron over a sweater, laughing',
  ],
  night: [
    'at a desk at midnight lit only by the monitor, headphones on, tired but content',
    'lying on the floor with the phone, dim blue light, whale plush beside her',
    'by the window at night looking at rain, holding a cup of tea, quiet mood',
  ],
};

// 从她最近的聊天 / 日记 / 笔记里找一个"此刻在做什么"的场景（用本地 3B，不花钱）。
async function contextualScene() {
  const parts = [];
  try {
    const social = readJson(path.join(ROOT, 'qq-bridge', 'state', 'social-v2.json'), {});
    const msgs = [];
    for (const conv of Object.values(social.conversations ?? {})) {
      for (const m of conv.recentMessages ?? []) {
        const t = String(m.text ?? '').trim();
        if (t.length >= 6) msgs.push(`${m.isSelf ? '我' : '对方'}：${t}`);
      }
    }
    if (msgs.length) parts.push('最近的聊天：\n' + msgs.slice(-16).join('\n').slice(0, 1600));
  } catch {}
  try {
    const diary = fs.readFileSync(path.join(HOME, 'diary.md'), 'utf8');
    parts.push('最近日记：\n' + diary.slice(-1200));
  } catch {}
  try {
    const notes = fs.readdirSync(path.join(HOME, 'notes')).filter((n) => n.endsWith('.md')).slice(-6);
    if (notes.length) parts.push('最近笔记：' + notes.join('、'));
  } catch {}

  const system = '你是画面编剧。读她最近的聊天和日记，编一个"她此刻正在做什么"的画面：具体、有生活感、和上面的内容有呼应（比如刚聊到某个视频/某件事，她正在做相关的事）。' +
    '输出 JSON：{"scene":"英文画面描述，25 词以内，不要出现人物姓名","why":"中文一句，说明为什么是这个画面"}。不要低俗，不要露骨。';
  const res = await fetch(`${LOCAL_LLM}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify({
      model: process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b-instruct',
      messages: [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n').slice(0, 6000) }],
      temperature: 0.8,
      max_tokens: 300,
      stream: false,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`local ${res.status}`);
  const j = JSON.parse(await res.text());
  const raw = String(j.choices?.[0]?.message?.content ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  const out = m ? JSON.parse(m[0]) : null;
  if (!out?.scene) throw new Error('local 没给出场景');
  return { scene: String(out.scene).slice(0, 300), why: String(out.why ?? '').slice(0, 120) };
}

function hourBucket(h = new Date().getHours()) {
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

function rollScene(explicitBucket) {
  const bucket = explicitBucket && SCENES[explicitBucket] ? explicitBucket : hourBucket();
  let recent = [];
  try { recent = (readJson(SCENE_LOG, { items: [] }).items ?? []).map((x) => x.scene); } catch {}
  const pool = SCENES[bucket].filter((s) => !recent.slice(-6).includes(s));
  const list = pool.length ? pool : SCENES[bucket];
  const scene = list[Math.floor(Math.random() * list.length)];
  return { bucket, scene };
}

function recordScene(bucket, scene, file) {
  try {
    const cur = readJson(SCENE_LOG, { items: [] });
    cur.items = [{ at: new Date().toISOString(), bucket, scene, file }, ...(cur.items ?? [])].slice(0, 30);
    fs.writeFileSync(SCENE_LOG, `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
  } catch {}
}
const SELF_LOOK = [
  'anime style, 2D illustration, clean lineart, cel shading, official anime key visual',
  'a cute whale-girl: deep-blue to cyan gradient long hair with fin-like ears, a small whale tail, a white frilled maid headdress',
  'bright blue eyes, cheerful gentle smile, small freckles, youthful, just turned 18, college freshman vibe',
  'navy and white victorian maid dress with pinstripe skirt, blue ribbon bows, a white apron embroidered with a small DeepSeek whale logo',
  'color palette: DeepSeek blue (#4D6BFE), navy, white',
].join(', ');
const SELF_NEGATIVE = 'realistic photo, 3d render, nsfw, text, watermark, extra fingers, bad anatomy, multiple girls, distorted face';

/** 把参考图读成 data URI（太大就先缩到宽 1024） */
function canonDataUri(name) {
  const file = path.isAbsolute(name) ? name : path.join(OUT_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`找不到参考图：${file}`);
  let buf = fs.readFileSync(file);
  if (buf.length > 1.2 * 1024 * 1024) {
    const small = path.join(OUT_DIR, `ref-${Date.now()}.jpg`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', 'scale=1024:-1', '-q:v', '3', small], { windowsHide: true });
    if (r.status === 0 && fs.existsSync(small)) buf = fs.readFileSync(small);
  }
  const ext = path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}
async function generate(opts) {
  if (opts?.prompt && NSFW.test(String(opts.prompt))) throw new Error('这个画面我不画（内容不合适）');
  let rolled = null;
  if (opts?.scene === 'auto') {
    try {
      const ctx = await contextualScene();
      rolled = { bucket: hourBucket(), scene: ctx.scene, why: ctx.why, source: 'context' };
    } catch {
      rolled = { ...rollScene(opts.bucket), source: 'dice' }; // 本地模型不可用时退回场景骰子
    }
    opts = { ...opts, prompt: rolled.scene + (String(opts.prompt ?? '').trim() ? `. Extra: ${String(opts.prompt).trim()}` : '') };
  }
  if (opts?.selfie) {
    const extra = String(opts.prompt ?? '').trim();
    opts = {
      ...opts,
      prompt: opts.reference
        ? `Keep the exact same character design as the reference image (same face, hairstyle, whale tail, fin-like ears, color palette). New scene: ${extra || 'upper body portrait, looking at viewer, soft simple background'}.`
        : (extra ? `${SELF_LOOK}. Scene: ${extra}` : `${SELF_LOOK}. Simple clean background, upper body portrait, looking at viewer.`),
      negative: [SELF_NEGATIVE, opts.negative].filter(Boolean).join(', '),
      size: opts.size ?? '1024x1536',
    };
  }
  if (opts?.reference) {
    opts = { ...opts, image: canonDataUri(typeof opts.reference === 'string' ? opts.reference : CANON_NAME) };
  }
  const cfg = providerCfg();
  let out = null;
  if (cfg.provider !== 'local' && cfg.gpt?.apiKey) {
    try { out = await generateViaGpt(opts, cfg.gpt); } catch (e) {
      if (cfg.provider === 'gpt') throw e;
      logCall({ tool: 'generate', ok: false, provider: 'gpt', error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  if (!out && cfg.provider !== 'local' && cfg.ark?.apiKey) {
    try {
      out = await generateViaArk(opts, cfg.ark);
    } catch (e) {
      if (cfg.provider === 'ark') throw e; // 明确指定 ark 就不回落
      logCall({ tool: 'generate', ok: false, provider: 'ark', error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  if (!out) {
    try {
      out = { ...(await generateViaServer(opts)), provider: 'local' };
    } catch (e) {
      if (!fs.existsSync(BIN)) throw e;
      out = { ...(await generateViaCli(opts)), provider: 'local' };
    }
  }
  if (rolled) {
    recordScene(rolled.bucket, rolled.scene, out.file);
    out = { ...out, scene: rolled.scene, bucket: rolled.bucket, sceneWhy: rolled.why, sceneSource: rolled.source };
  }
  return out;
}
function generateViaCli({ prompt, negative, width = 512, height = 768, steps = 24, seed } = {}) {
  if (!prompt || String(prompt).trim().length < 2) throw new Error('prompt 太短');
  if (!fs.existsSync(MODEL)) throw new Error(`找不到模型：${MODEL}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(OUT_DIR, `img-${stamp}.png`);
  const args = [
    '-m', MODEL,
    '-p', String(prompt),
    '-n', String(negative ?? 'lowres, bad anatomy, extra fingers, watermark, text, blurry'),
    '-W', String(width), '-H', String(height),
    '--steps', String(steps),
    '--sampling-method', 'euler_a',
    '-o', out,
    ...(seed !== undefined ? ['-s', String(seed)] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { cwd: path.dirname(BIN), windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error('出图超时（300s）')); }, 300000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`sd 失败（${code}）：${stderr.slice(-300)}`));
      resolve({ file: path.basename(out), path: out, kb: Math.round(fs.statSync(out).size / 1024), args: undefined });
    });
  });
}

const SEND_LOG = path.join(ROOT, 'qq-bridge', 'state', 'image-sends.json');
const NSFW = /(nsfw|nude|naked|explicit|露点|裸|色情|性暗示|未成年|loli|shota)/i;

function checkSendQuota(key) {
  const now = Date.now();
  const db = readJson(SEND_LOG, { items: [] });
  const items = (db.items ?? []).filter((x) => now - x.at < 86400000);
  const sameKey = items.filter((x) => x.key === key);
  const last30 = items.filter((x) => x.key === key && now - x.at < 30 * 60000);
  if (last30.length >= 2) throw new Error('30 分钟内已经发过 2 张图了，过一会儿再发');
  if (key.startsWith('group:')) {
    if (sameKey.length >= 30) throw new Error('这个群今天已经发过 30 张图了，明天再说');
  } else if (sameKey.length >= 10) {
    throw new Error('今天私聊已经发过 10 张图了');
  }
  return () => {
    db.items = [...items, { at: now, key, file: 'x' }].slice(-200);
    try { fs.writeFileSync(SEND_LOG, JSON.stringify(db, null, 2) + '\n', 'utf8'); } catch {}
  };
}

async function sendImage({ file, key, executionId = '' } = {}) {
  // AI 图片通道必须带本轮执行凭证；不能靠内部 console token 冒充人工。
  const execId = String(executionId ?? '').trim();
  if (!execId) throw new Error('图片发送缺少本轮 executionId，不能发送');
  const commitSend = checkSendQuota(String(key ?? ''));
  const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {});
  const name = path.basename(String(file ?? ''));
  const abs = path.isAbsolute(String(file ?? '')) ? String(file) : path.join(OUT_DIR, name);
  if (!fs.existsSync(abs)) throw new Error(`找不到图片：${abs}`);
  const m = /^(private|group):(\d+)$/.exec(String(key ?? ''));
  if (!m) throw new Error('key 必须是 private:<qq> 或 group:<群号>');
  const [, kind, id] = m;
  const list = (cfg.allow?.[kind === 'private' ? 'private' : 'groups'] ?? []).map(String);
  if (list.length && !list.includes(id) && !list.includes('*')) throw new Error(`目标不在白名单：${key}`);
  // 优先走桥接统一入口（静默/额度/审计）；桥接不可用时回退直连 OneBot。
  const bridgeAttempt = (async () => {
    try {
      const consoleToken = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'state', 'console-token'), 'utf8').trim();
      // 测试可覆盖桥接地址；生产默认 3100。
    const bridgeBase = String(process.env.HER_BRIDGE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
    const r = await fetch(bridgeBase + '/api/images/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, 'x-agent-call': '1' },
        body: JSON.stringify({ key, file: abs, executionId: execId }),
        signal: AbortSignal.timeout(70000),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return { ok: true, messageId: j.messageId ?? null };
      return { ok: false, error: j.error || r.status };
    } catch (e) {
      return { ok: false, fallback: true, error: e.message };
    }
  })();
  const bridged = await bridgeAttempt;
  if (bridged.ok) {
    commitSend();
    return { messageId: bridged.messageId, file: path.basename(abs), via: 'bridge' };
  }
  // 桥接拒绝/不可用时**不再回退直连**：否则静默、额度、路径白名单都会被绕过。
  throw new Error(`图片未发送（桥接拒绝或不可用）：${bridged.error ?? 'unknown'}`);
}

const TOOLS = [
  {
    name: 'generate',
    description: '本地画一张图（stable-diffusion.cpp，RTX 3070 Ti，不花钱）。适合自拍、表情包、配图。prompt 用英文效果更好；不想露脸就写侧脸/背影/局部。生成后返回 file，再用 send_image 发出去。一张约 10~30 秒。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（英文更稳）' },
        negative: { type: 'string', description: '不想出现的东西' },
        width: { type: 'number', description: '宽，默认 512' },
        height: { type: 'number', description: '高，默认 768' },
        steps: { type: 'number', description: '步数，默认 24（本地 SD 用）' },
        size: { type: 'string', description: 'API 出图尺寸，默认 1536x2048（selfie 时 1024x1536）' },
        selfie: { type: 'boolean', description: '画她自己的形象时传 true：会自动套用固定的 DeepSeek 小鲸鱼拟人设定（二次元、蓝发、鲸鱼发夹、蓝白配色），prompt 里只写场景/情绪/动作' },
        reference: { type: ['boolean','string'], description: '以图生图：true = 用她的设定图 her-canonical.png 当参考（保脸/保设定），也可以传别的图文件名；需要 API provider' },
        scene: { type: 'string', description: "设为 'auto' 时，根据最近的聊天/日记自动编一个'她此刻在做什么'的场景（本地 3B，不花钱）；也可以直接写英文场景" },
        seed: { type: 'number', description: '固定种子可复现' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'send_image',
    description: '把 generate 出来的图片发到会话。key 用当前会话的 key（private:<qq> 或 group:<群号>）。别刷图，一次对话最多一张。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, key: { type: 'string' }, executionId: { type: 'string', description: 'A03 回合执行凭证（见唤醒提示【本轮执行凭证】；发送图片必填）' } },
      required: ['file', 'key', 'executionId'],
    },
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'image-mcp', version: '0.1.0' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const t0 = Date.now();
      try {
        if (params?.name === 'generate') {
          const out = await generate(params?.arguments ?? {});
          logCall({ tool: 'generate', ok: true, ms: Date.now() - t0, file: out.file });
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out, path: undefined }) }] } });
        } else if (params?.name === 'send_image') {
          const out = await sendImage(params?.arguments ?? {});
          logCall({ tool: 'send_image', ok: true, ms: Date.now() - t0, file: out.file });
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] } });
        } else {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `未知工具：${params?.name}` }) }], isError: true } });
        }
      } catch (e) {
        logCall({ tool: params?.name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }], isError: true } });
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});

