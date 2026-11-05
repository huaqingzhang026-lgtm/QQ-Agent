// 手动补发两条 QQ 空间说说（主人临时给额度时用）。
// 用法：node tools\qzone-post-now.mjs [条数]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQzoneText, generateQzoneImage, noteQzonePost } from '../qq-bridge/src/qzone-auto.js';
import { postOneBot } from '../qq-bridge/src/transport.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const qcfg = cfg.socialV2?.qzone ?? {};
const stateFile = path.join(ROOT, 'qq-bridge', 'state', 'qzone-auto.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}

const count = Math.max(1, Math.min(2, Number(process.argv[2]) || 2));
const localDay = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

function buildContext() {
  const parts = [];
  const daily = path.join(ROOT, 'agent-home', 'notes', 'daily', `${localDay}.md`);
  if (fs.existsSync(daily)) {
    const human = fs.readFileSync(daily, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !/(Her[A-Z]|bridge|\bmjs\b|pid|端口|token|日志|任务|重启|心跳|acceptance|模型|代码|部署|API|DSH|cron|日报|^-\s*agent-home|^-\s*docs\b|^\|)/i.test(l))
      .slice(-20).join('\n');
    if (human) parts.push(human);
  }
  const browse = path.join(ROOT, 'agent-home', 'notes', 'browse', `${localDay}.md`);
  if (fs.existsSync(browse)) {
    const lines = fs.readFileSync(browse, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-12);
    if (lines.length) parts.push(lines.join('\n'));
  }
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

async function postOne(text) {
  let image = null;
  if (Math.random() < (Number(qcfg.imageProbability) || 0)) {
    try { image = await generateQzoneImage({ cfg, text, mode: cfg.socialV2?.qzone?.imageMode || 'single', providerFile: path.join(ROOT, 'image-provider.json') }); } catch {}
    if (!image?.length && (cfg.socialV2?.qzone?.imageMode === 'comic')) { try { image = await generateQzoneImage({ cfg, text, mode: 'single', providerFile: path.join(ROOT, 'image-provider.json') }); } catch {} }
  }
  const params = { content: text, ugc_right: Number(qcfg.ugcRight) || 4 };
  if (image?.length) params.images = [`base64://${image.toString('base64')}`];
  const res = await postOneBot({
    action: 'send_qzone_msg', params,
    httpUrl: String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: cfg.snowluma?.accessToken, timeoutMs: 180000,
  });
  const ok = res?.ok !== false && (res?.body?.status === 'ok' || res?.body?.retcode === 0 || res?.ok === true);
  console.log(ok ? `[ok] ${image ? '带图' : '纯文字'}：${text}` : `[fail] ${JSON.stringify(res?.body ?? res).slice(0, 300)}`);
  return { ok, text, image: !!image?.length };
}

for (let i = 0; i < count; i++) {
  const text = await generateQzoneText({ cfg, context: buildContext(), recent: Array.isArray(state.recent) ? state.recent : [] });
  if (!text) { console.log('[skip] 文案空泛，未发'); continue; }
  const r = await postOne(text);
  if (!r.ok) continue;
  const prevRecent = Array.isArray(state.recent) ? state.recent : [];
  state = noteQzonePost(state, Date.now());
  state.lastText = text;
  state.recent = [...prevRecent, text].slice(-5);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
