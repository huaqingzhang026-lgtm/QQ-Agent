// 生成两条 QQ 空间九宫格（每格 3 个候选，选最好；其余留素材），并同步两条 B 站动态。
// 用法：node tools\qzone-grid-now.mjs [posts=2] [panels=9] [variants=3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQzoneText, generateBiliDynamicText, postBiliDynamic } from '../qq-bridge/src/qzone-auto.js';
import { describeVisuals } from '../qq-bridge/src/vision.js';
import { postOneBot } from '../qq-bridge/src/transport.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const provider = JSON.parse(fs.readFileSync(path.join(ROOT, 'image-provider.json'), 'utf8'));
const gpt = provider.gpt;
const ark = provider.ark;
let gptBlocked = false;
const refPath = path.join(ROOT, 'agent-home', 'notes', 'images', 'her-canonical.png');
const ref = fs.readFileSync(refPath);
const refData = 'data:image/png;base64,' + ref.toString('base64');
const stateFile = path.join(ROOT, 'qq-bridge', 'state', 'qzone-auto.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
const posts = Math.max(1, Math.min(3, Number(process.argv[2]) || 2));
const panels = Math.max(1, Math.min(9, Number(process.argv[3]) || 9));
const variants = Math.max(1, Math.min(3, Number(process.argv[4]) || 3));
const localDay = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a);

function contextNow() {
  const parts = [];
  const daily = path.join(ROOT, 'agent-home', 'notes', 'daily', `${localDay}.md`);
  if (fs.existsSync(daily)) {
    const human = fs.readFileSync(daily, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !/(Her[A-Z]|bridge|\bmjs\b|pid|端口|token|日志|任务|重启|心跳|acceptance|模型|代码|部署|API|DSH|cron|日报|^-\s*agent-home|^-\s*docs\b|^\|)/i.test(l))
      .slice(-20).join('\n');
    if (human) parts.push(human);
  }
  const browse = path.join(ROOT, 'agent-home', 'notes', 'browse', `${localDay}.md`);
  if (fs.existsSync(browse)) parts.push(fs.readFileSync(browse, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-12).join('\n'));
  try {
    const dir = path.join(ROOT, 'agent-home', 'notes');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/^(index|更正台账)/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 2);
    for (const { f } of files) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, 8).join(' ').slice(0, 500);
      if (body) parts.push(f.replace(/\.md$/, '') + '：' + body);
    }
  } catch {}
  return parts.join('\n').slice(-2400);
}

async function arkEdit(prompt) {
  const body = { model: ark.model, prompt, size: ark.size || '1536x2048', response_format: 'url', watermark: false, image: [refData] };
  const r = await fetch(String(ark.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '') + '/images/generations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ark.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error('ark ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json(); const url = j?.data?.[0]?.url; if (!url) throw new Error('ark no url');
  const ir = await fetch(url, { signal: AbortSignal.timeout(60000) }); return Buffer.from(await ir.arrayBuffer());
}

async function gptEdit(prompt) {
  if (gptBlocked) return arkEdit(prompt);
  try { return await gptEditOnce(prompt); } catch (e) {
    if (/503|No available compatible accounts|502/.test(e.message)) { gptBlocked = true; log('GPT 暂不可用，切 Ark 兜底'); return arkEdit(prompt); }
    throw e;
  }
}

async function gptEditOnce(prompt) {
  const fd = new FormData();
  fd.append('model', gpt.model || 'gpt-image-2.5-flare');
  fd.append('prompt', prompt);
  fd.append('size', gpt.size || '1024x1536');
  fd.append('n', '1');
  fd.append('image', new Blob([ref], { type: 'image/png' }), 'persona.png');
  const r = await fetch(String(gpt.baseUrl || 'https://relay.example.invalid/v1').replace(/\/$/, '') + '/images/edits', {
    method: 'POST', headers: { authorization: 'Bearer ' + gpt.apiKey }, body: fd, signal: AbortSignal.timeout(240000),
  });
  if (!r.ok) throw new Error('gpt ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  const item = j?.data?.[0] || {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) { const ir = await fetch(item.url); return Buffer.from(await ir.arrayBuffer()); }
  throw new Error('gpt no image');
}

const beat = ['远景：场景和她在做什么', '中景：核心动作开始', '特写：最关键的手部/物件', '表情：她的反应', '细节：第二关键物件/小动作', '侧面：旁观者的反应', '转折：发现/出错的瞬间', '结果：她怎么收场', '收尾：环境或情绪定格'];

async function makePanel(text, i, total, dir) {
  const candidates = [];
  for (let v = 1; v <= variants; v++) {
    const prompt = `二次元日系动漫漫画分镜，第 ${i}/${total} 格。同一个18岁蓝发少女，蓝眼睛、鲸鱼发夹、女仆装、鲸鱼尾巴，严格参照参考图，脸型/发色/服装一致。这一格要画：${beat[(i - 1) % beat.length]}。整段内容：${String(text).slice(0, 120)}。只画这一格，不要拼成九宫格，不要文字/对白/水印/写实照片。`;
    try {
      const buf = await gptEdit(prompt);
      const file = path.join(dir, `p${String(i).padStart(2, '0')}-v${v}.png`);
      fs.writeFileSync(file, buf);
      let verdict = '';
      try {
        verdict = String(await describeVisuals({ images: [{ buffer: ref, mimeType: 'image/png' }, { buffer: buf, mimeType: 'image/png' }], kind: 'image', cfg,
          prompt: `第一张是角色设定图，第二张是第 ${i}/${total} 格。正文：${String(text).slice(0, 120)}。判断：1) 是否二次元动漫；2) 是否同一角色；3) 有无畸形/文字/水印；4) 是否画出这一格要求的动作（${beat[(i - 1) % beat.length]}）。只输出 PASS 或 FAIL:原因。` }) || '');
      } catch {}
      candidates.push({ buf, file, pass: /^PASS\b/i.test(verdict.trim()), verdict });
      log(`格 ${i} 候选 ${v}: ${/^PASS\b/i.test(verdict.trim()) ? 'PASS' : 'FAIL'}`);
    } catch (e) { log(`格 ${i} 候选 ${v} 失败：${e.message}`); }
  }
  const best = candidates.find((x) => x.pass) || candidates[0];
  return best?.buf || null;
}

async function makePost(text, index) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, 'agent-home', 'notes', 'images', 'qzone-grid', stamp + '-p' + index);
  fs.mkdirSync(dir, { recursive: true });
  const selected = [];
  for (let i = 1; i <= panels; i++) {
    const buf = await makePanel(text, i, panels, dir);
    if (buf) selected.push(buf);
    log(`完成 ${i}/${panels}，已选 ${selected.length}`);
  }
  if (!selected.length) return { ok: false, error: 'no images' };
  const images = selected.map((b) => 'base64://' + b.toString('base64'));
  const res = await postOneBot({ action: 'send_qzone_msg', params: { content: text, ugc_right: 4, images }, httpUrl: String(cfg.snowluma.httpUrl).replace(/\/+$/, ''), accessToken: cfg.snowluma.accessToken, timeoutMs: 180000 });
  const ok = res?.ok !== false && (res?.body?.status === 'ok' || res?.body?.retcode === 0 || res?.ok === true);
  log(`Qzone post ${ok ? 'OK' : 'FAIL'}：${text}`);
  return { ok, res, dir, selected };
}

for (let n = 1; n <= posts; n++) {
  const text = await generateQzoneText({ cfg, context: contextNow(), recent: Array.isArray(state.recent) ? state.recent : [] });
  if (!text) { log('文案空，跳过'); continue; }
  const r = await makePost(text, n);
  if (!r.ok) continue;
  const biliText = (await generateBiliDynamicText({ cfg, mode: 'sync', qzoneText: text, recent: Array.isArray(state.recent) ? state.recent : [] })) || text;
  try {
    const b = await postBiliDynamic({ text: biliText, imageBuffer: r.selected[0], cookieFile: path.join(ROOT, 'bili-mcp', 'cookie.json') });
    log('B站动态', b.ok ? 'OK ' + b.id : 'FAIL ' + b.error);
  } catch (e) { log('B站动态异常', e.message); }
  state.recent = [...(Array.isArray(state.recent) ? state.recent : []), text].slice(-5);
  state.lastText = text;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
