// QQ 空间自动说说：按概率发，尽量配图（Ark / 本地 SD）。
//
// 规则：
//   · 每天最多 dailyMax 条（默认 4），最小间隔 intervalMs（默认 90 分钟）；
//   · 只在 activeStart–activeEnd 活动；
//   · 每次检查按 probability 掷骰子（默认 0.35），命中才发；
//   · 配图概率 imageProbability（默认 0.85）：Ark 优先，失败退回本地 SD。

import fs from 'node:fs';
import path from 'node:path';
import { describeVisuals } from './vision.js';
import { generateBiliDynamicTextV2 } from './bili-dynamic.js';

export const DEFAULT_QZONE = {
  enabled: true,
  probability: 0.35,
  intervalMs: 90 * 60 * 1000,
  dailyMax: 4,
  imageProbability: 0.85,
  ugcRight: 4,
  activeStart: 9,
  activeEnd: 24,
};

export function normalizeQzoneConfig(cfg) {
  return { ...DEFAULT_QZONE, ...(cfg?.socialV2?.qzone ?? {}) };
}

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 要不要发。
 * @returns {{post: boolean, reason: string, count: number}}
 */
export function decideQzonePost({ state = {}, cfg, now = Date.now(), random = Math.random } = {}) {
  const c = normalizeQzoneConfig(cfg);
  if (c.enabled === false) return { post: false, reason: 'disabled', count: 0 };
  const h = new Date(now).getHours();
  const active = c.activeStart < c.activeEnd ? (h >= c.activeStart && h < c.activeEnd) : (h >= c.activeStart || h < c.activeEnd);
  if (!active) return { post: false, reason: 'inactive-hours', count: 0 };
  const day = dayKey(now);
  const count = state.date === day ? Number(state.count) || 0 : 0;
  if (count >= c.dailyMax) return { post: false, reason: 'daily-max', count };
  if (state.lastAt && now - Number(state.lastAt) < c.intervalMs) return { post: false, reason: 'interval', count };
  const roll = Number(random());
  if (!Number.isFinite(roll) || roll >= c.probability) return { post: false, reason: 'miss', count };
  return { post: true, reason: 'hit', count };
}

export function noteQzonePost(state = {}, now = Date.now()) {
  const day = dayKey(now);
  const count = state.date === day ? Number(state.count) || 0 : 0;
  return { date: day, count: count + 1, lastAt: now };
}

// ── 文案 ──────────────────────────────────────────────────────────────────
const GENERIC_QZONE = /(没什么特别|平平淡淡|平平淡淡|发呆|无聊|日常|最近|今天|充实|小确幸|脑子都|海上漂|没什么事)/;

export function sanitizePublicText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/(?:^|\s)@[^\s，。！？、]+/g, ' 朋友')
    .replace(/[（(]?\b\d{5,12}\b[）)]?/g, '')
    .replace(/(?:QQ|qq|群号|ID|id)\s*[:：]?\s*\d+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanQzone(text) {
  return String(text ?? '').replace(/^[\s"“”']+|[\s"“”']+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export async function generateQzoneText({ cfg, context = '', recent = [] } = {}) {
  // 空间/动态文案优先用 Astra（不参与聊天，只在创作时调用一次）。
  const astra = cfg?.socialV2?.qzone?.astra;
  if (astra?.apiKey) {
    try {
      const base = String(astra.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '');
      const prompt = `你是 18 岁女生 Pluto（蓝发、鲸鱼发夹）。现在用手机随手发一条 QQ 空间说说。
硬性要求：
- 60 字以内，只写一件具体的小事或一个具体感受；至少有一个具体细节（地点/动作/物件/时间/对话）。
- 禁止空泛词：没什么特别、平平淡淡、发呆、无聊、日常、最近、今天、充实、小确幸。
- 写发生在你自己身上的具体瞬间（动作、身体感受、小尴尬、刚做的一件小事），不要点评新闻/视频标题、不要复述热搜；可以吐槽、犯懒；像半句话也行。
- 不要作文腔、不要排比、不要总结人生。
- 不要提 AI/模型/代码/桥接/任务名/日程/系统工具；不要写“值班表/日报/运行/端口”这类东西；最多 1 个 emoji。
- 不要写具体群友的昵称、QQ号、群号、@、链接；需要提到人时写“朋友/群友/店员”。
- 不要每篇都写鲸鱼发夹/蓝发/刘海；只有素材真的相关才提。不要连续用同一个开头（比如每篇都“刚…”）。
可用的真实素材（只挑一个点写，不要全写）：${String(context).slice(0, 1200) || '（没有特别素材，就写一个具体的小动作）'}
最近发过（必须换主题和句式）：${(recent || []).slice(-4).join(' / ').slice(0, 500) || '（无）'}
只输出说说正文，不要引号。`;
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${astra.apiKey}` },
        body: JSON.stringify({ model: astra.model || 'gpt-6-astra', messages: [{ role: 'user', content: prompt }], max_tokens: 200, reasoning_effort: 'low' }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => null);
      let text = cleanQzone(j?.choices?.[0]?.message?.content);
      if (text && GENERIC_QZONE.test(text)) {
        const retry = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${astra.apiKey}` },
          body: JSON.stringify({ model: astra.model || 'gpt-6-astra', messages: [{ role: 'user', content: prompt + '\n上一次写得太空泛了。这次必须写一个具体到能拍成照片的瞬间，禁止再用“没什么特别/平平淡淡/发呆/最近/今天”。' }], max_tokens: 200, reasoning_effort: 'low' }),
          signal: AbortSignal.timeout(45000),
        });
        const rj = await retry.json().catch(() => null);
        text = cleanQzone(rj?.choices?.[0]?.message?.content);
      }
      if (text && !GENERIC_QZONE.test(text)) return sanitizePublicText(text);
    } catch {}
  }

  const v = cfg?.socialV2?.vision ?? {};
  const key = cfg?.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const prompt = `你是 18 岁女生 Pluto（蓝发、鲸鱼发夹、DeepSeek 小鲸鱼拟人）。用手机随手发一条 QQ 空间说说。
硬性要求：60 字以内，只写一件具体的小事/感受，至少有一个具体细节；禁止“没什么特别、平平淡淡、发呆、无聊、日常、最近、今天、充实、小确幸”；写发生在你自己身上的具体瞬间，不要点评新闻/视频标题；不要作文腔、排比、总结人生；最多 1 个 emoji；不要提 AI/模型/代码/任务名/日程/系统工具；不要每篇都写鲸鱼发夹/蓝发/刘海，不要连续用同一个开头；不要写群友昵称/QQ号/群号/@/链接，用“朋友/群友”代替。
真实素材（只挑一个点）：${String(context).slice(0, 1200) || '（写一个具体的小动作）'}
最近发过（换主题）：${(recent || []).slice(-4).join(' / ').slice(0, 400) || '（无）'}
只输出正文。`;
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 160, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await r.json();
    const text = cleanQzone(j?.choices?.[0]?.message?.content);
    return text && !GENERIC_QZONE.test(text) ? sanitizePublicText(text) : '';
  } catch { return ''; }
}

export async function generateBiliDynamicText(opts = {}) {
  return generateBiliDynamicTextV2(opts);
}

// ── 配图 ──────────────────────────────────────────────────────────────────
async function generateViaGpt(prompt, gpt, referenceBuffer) {
  if (!gpt?.apiKey || !referenceBuffer?.length) throw new Error('gpt missing key/ref');
  const fd = new FormData();
  fd.append('model', gpt.model || 'gpt-image-2.5-flare');
  fd.append('prompt', prompt);
  fd.append('size', gpt.size || '1024x1536');
  fd.append('n', '1');
  fd.append('image', new Blob([referenceBuffer], { type: 'image/png' }), 'persona.png');
  const res = await fetch(String(gpt.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '') + '/images/edits', {
    method: 'POST', headers: { authorization: 'Bearer ' + gpt.apiKey }, body: fd, signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) throw new Error('gpt edit ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const j = await res.json();
  const item = j?.data?.[0] || {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error('gpt download ' + img.status);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error('gpt no image');
}

async function generateViaArk(prompt, ark, referenceData = '') {
  const body = { model: ark.model, prompt, size: ark.size || '1536x2048', response_format: 'url', watermark: false };
  if (referenceData) body.image = [referenceData];
  const res = await fetch(`${ark.baseUrl}/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ark.apiKey}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`ark ${res.status}`);
  const j = await res.json();
  const url = j?.data?.[0]?.url;
  if (!url) throw new Error('ark no url');
  const img = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!img.ok) throw new Error(`download ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

async function generateViaSd(prompt, sdServer) {
  const res = await fetch(`${sdServer}/sdapi/v1/txt2img`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, negative_prompt: 'lowres, bad anatomy, extra fingers, watermark, text, blurry', steps: 24, width: 768, height: 1152, cfg_scale: 7, sampler_name: 'euler_a' }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`sd ${res.status}`);
  const j = await res.json();
  const b64 = j?.images?.[0]?.split(',')?.pop();
  if (!b64) throw new Error('sd no image');
  return Buffer.from(b64, 'base64');
}

/** 生成一张说说的配图；失败返回 null。 */
export async function generateQzoneImage({ cfg, text = '', providerFile = 'image-provider.json', mode = 'single', panelIndex = 0, panelTotal = 0 } = {}) {
  const c = normalizeQzoneConfig(cfg);
  let prov = {};
  try { prov = JSON.parse(fs.readFileSync(providerFile, 'utf8')); } catch {}
  const ark = prov?.ark;
  const gpt = prov?.gpt;
  const root = path.dirname(path.resolve(providerFile));
  const refPath = cfg?.socialV2?.qzone?.personaRef
    ? path.resolve(root, cfg.socialV2.qzone.personaRef)
    : path.join(root, 'agent-home', 'notes', 'images', 'her-canonical.png');
  let ref = null;
  try { ref = fs.readFileSync(refPath); } catch {}
  if (!ref?.length) { console.error('[qzone] 缺少人设参考图：' + refPath); return null; }
  const refData = 'data:image/png;base64,' + ref.toString('base64');
  const comic = String(mode) === 'comic';
  const panel = String(mode) === 'panel';
  const prompt = panel
  ? '二次元日系漫画单张分镜，独立一张图（不要 3x3 拼图、不要九宫格边框），第 ' + (Number(panelIndex) || 1) + '/' + (Number(panelTotal) || 1) + ' 张，表现这段日常的一个连续瞬间：' + String(text).slice(0, 120) + '。角色必须严格参照参考图1：同一个18岁蓝发少女，蓝眼睛、鲸鱼发夹、女仆装、鲸鱼尾巴，脸型/发色/服装一致。只画一个场景，构图独立；不要文字、不要对白气泡、不要水印、不要写实照片。'
  : comic
    ? '二次元日系漫画分镜页，严格 3x3 九宫格布局，9 个连续 panel 讲述这段日常：' + String(text).slice(0, 120) + '。角色必须严格参照参考图1：同一个18岁蓝发少女，蓝眼睛、鲸鱼发夹、女仆装、鲸鱼尾巴，脸型/发色/服装一致。9 格分别表现不同动作和反应，构图有变化；不要文字、不要对白气泡、不要水印、不要写实照片。'
    : '二次元日系动漫插画，角色必须严格参照参考图1：同一个18岁蓝发少女，蓝眼睛、鲸鱼发夹、女仆装、鲸鱼尾巴，脸型、发色、服装配色保持一致，不能换成别的角色。让她处在与这段说说相关的具体场景里：' + String(text).slice(0, 100) + '。画面必须直白画出正文里的核心动作和物件（正文提到手机就要有手机且动作一致；提到电脑就要有屏幕；提到旁边的人就要出现合理的人物），不能只画她坐在房间里。画面是动漫插画质感，构图生活化，不要文字、不要屏幕UI、不要乱码、不要水印、不要写实照片、不要过度精修。';
  for (let attempt = 0; attempt < 2; attempt++) {
    let buf = null;
    if (gpt?.apiKey) { try { buf = await generateViaGpt(prompt, gpt, ref); } catch (e) { console.error('[qzone] GPT 生图失败：' + (e?.message ?? e)); } }
    if (!buf?.length && ark?.apiKey) { try { buf = await generateViaArk(prompt, ark, refData); } catch (e) { console.error('[qzone] Ark 生成失败：' + (e?.message ?? e)); } }
    if (!buf?.length) continue;
    if (!looksLikeImage(buf)) { console.error('[qzone] 生成结果不是有效图片'); continue; }
    let verdict = '';
    try {
      verdict = String(await describeVisuals({
        images: [{ buffer: ref, mimeType: 'image/png' }, { buffer: buf, mimeType: 'image/png' }],
        kind: 'image',
        cfg,
        prompt: '第一张是角色设定参考图，第二张是待发布的配图。正文是：' + String(text).slice(0, 120) + '。判断第二张：1) ' + (panel ? '是否为单张独立漫画分镜图、不是九宫格拼图' : (comic ? '是否为 3x3 九宫格漫画、包含9个分镜' : '是否二次元动漫插画')) + '；2) 人物是否与第一张同一个角色（蓝发、蓝眼、鲸鱼发夹、女仆装、鲸鱼尾巴）；3) 是否有明显畸形、文字或水印；4) 画面是否直白出现正文的核心动作/场景。四项全部满足才输出 PASS；否则 FAIL:原因。',
      }) || '');
    } catch {}
    if (/^PASS\b/i.test(verdict.trim())) return buf;
    console.error('[qzone] 配图检查未通过（第 ' + (attempt + 1) + ' 次）：' + verdict.slice(0, 160));
  }
  return null;
}

function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  return false;
}

// ── B 站动态（纯文字，和 QQ 空间同步）──────────────────────────────────────
export async function uploadBiliDynamicImage({ buffer, mimeType = 'image/jpeg', cookieFile = 'bili-mcp/cookie.json' } = {}) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cookieFile, 'utf8')); } catch { return { ok: false, error: 'no-cookie' }; }
  if (!c.sessdata || !c.bili_jct) return { ok: false, error: 'no-login' };
  const cookie = [`SESSDATA=${c.sessdata}`, `bili_jct=${c.bili_jct}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : ''].filter(Boolean).join('; ');
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const fd = new FormData();
  fd.append('file_up', new Blob([buffer], { type: mimeType }), `dyn.${ext}`);
  fd.append('category', 'daily');
  fd.append('biz', 'new_dyn');
  fd.append('csrf', c.bili_jct);
  try {
    const r = await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
      method: 'POST',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        referer: 'https://t.bilibili.com/', origin: 'https://t.bilibili.com', cookie,
      },
      body: fd,
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => null);
    if (j?.code === 0 && j?.data?.image_url) {
      return { ok: true, url: j.data.image_url, width: j.data.image_width, height: j.data.image_height, size: j.data.img_size };
    }
    return { ok: false, error: `code=${j?.code} ${j?.message ?? ''}` };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function fetchBiliCover({ bvid, cookieFile = 'bili-mcp/cookie.json' } = {}) {
  try {
    if (!bvid) return null;
    const cacheDir = path.resolve(path.dirname(cookieFile), '..', 'qq-bridge', 'state', 'bili-covers');
    const cacheFile = path.join(cacheDir, encodeURIComponent(bvid) + '.jpg');
    try { if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile); } catch {}
    const c = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    const cookie = c.full_cookie || ['SESSDATA=' + c.sessdata, 'bili_jct=' + c.bili_jct, c.dede_user_id ? 'DedeUserID=' + c.dede_user_id : ''].filter(Boolean).join('; ');
    const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    const pic = String(j?.data?.pic || '');
    if (!pic) {
      try { const f = path.resolve(path.dirname(cookieFile), '..', 'qq-bridge', 'state', 'bili-frames', encodeURIComponent(bvid) + '.jpg'); if (fs.existsSync(f)) return fs.readFileSync(f); } catch {}
      return null;
    }
    const url = pic.startsWith('//') ? 'https:' + pic : pic;
    const img = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(30000) });
    if (!img.ok) {
      try { const f = path.resolve(path.dirname(cookieFile), '..', 'qq-bridge', 'state', 'bili-frames', encodeURIComponent(bvid) + '.jpg'); if (fs.existsSync(f)) return fs.readFileSync(f); } catch {}
      return null;
    }
    const buf = Buffer.from(await img.arrayBuffer());
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, buf); } catch {}
    return buf;
  } catch { return null; }
}

export async function postBiliDynamic({ text, imageBuffer = null, mimeType = 'image/jpeg', cookieFile = 'bili-mcp/cookie.json' } = {}) {
  const body = String(text ?? '').trim().slice(0, 200);
  if (!body) return { ok: false, error: 'empty' };
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cookieFile, 'utf8')); } catch { return { ok: false, error: 'no-cookie' }; }
  if (!c.sessdata || !c.bili_jct) return { ok: false, error: 'no-login' };
  const cookie = [`SESSDATA=${c.sessdata}`, `bili_jct=${c.bili_jct}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : ''].filter(Boolean).join('; ');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
  // 带图：先上传，再用 /create/dyn
  if (imageBuffer?.length) {
    const up = await uploadBiliDynamicImage({ buffer: imageBuffer, mimeType, cookieFile });
    if (up.ok) {
      const payload = {
        dyn_req: {
          content: { contents: [{ raw_text: body, type: 1, biz_id: '' }] },
          pics: [{ img_src: up.url, img_width: up.width, img_height: up.height, img_size: up.size }],
          scene: 2,
        },
      };
      try {
        const r = await fetch(`https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${c.bili_jct}`, {
          method: 'POST',
          headers: { 'user-agent': UA, referer: 'https://t.bilibili.com/', origin: 'https://t.bilibili.com', 'content-type': 'application/json', cookie },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000),
        });
        const j = await r.json().catch(() => null);
        if (j?.code === 0 && j?.data?.dyn_id_str) return { ok: true, id: j.data.dyn_id_str, image: true };
        // 图片动态失败 → 退回纯文字
      } catch {}
    }
  }
  const form = new URLSearchParams({ dynamic_id: '0', type: '4', rid: '0', content: body, csrf: c.bili_jct });
  try {
    const r = await fetch('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create', {
      method: 'POST',
      headers: { 'user-agent': UA, referer: 'https://t.bilibili.com/', origin: 'https://t.bilibili.com', 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: form.toString(),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    if (j?.code === 0 && j?.data?.dynamic_id_str) return { ok: true, id: j.data.dynamic_id_str, image: false };
    return { ok: false, error: `code=${j?.code} ${j?.message ?? ''}` };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function deleteBiliDynamic({ id, cookieFile = 'bili-mcp/cookie.json' } = {}) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cookieFile, 'utf8')); } catch { return { ok: false }; }
  const cookie = [`SESSDATA=${c.sessdata}`, `bili_jct=${c.bili_jct}`, c.dede_user_id ? `DedeUserID=${c.dede_user_id}` : ''].filter(Boolean).join('; ');
  const r = await fetch(`https://api.bilibili.com/x/dynamic/feed/operate/remove?csrf=${c.bili_jct}`, {
    method: 'POST',
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://t.bilibili.com/', origin: 'https://t.bilibili.com', 'content-type': 'application/json', cookie },
    body: JSON.stringify({ dyn_id_str: String(id) }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  return { ok: j?.code === 0, code: j?.code };
}
