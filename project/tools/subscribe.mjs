// 管理订阅（她关心的东西）。也可以用 memory MCP 里的 subscribe_* 工具。
//
// 用法：
//   node tools\subscribe.mjs list
//   node tools\subscribe.mjs add --kind weibo_hot --keywords "AI,大模型" [--name 科技]
//   node tools\subscribe.mjs add --kind bili_dynamic --uid 946974 --name 影视飓风
//   node tools\subscribe.mjs add --kind rss --url https://sspai.com/feed --name 少数派
//   node tools\subscribe.mjs remove <id>
//
// 新增的订阅第一次跑 subscribe-check 时只建基线、不推送（不会把历史全倒出来）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = path.join(ROOT, 'subscriptions.json');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };
const conf = (() => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8').replace(/^\uFEFF/, '')); } catch { return { targets: [] }; } })();
const save = () => fs.writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

const cmd = process.argv[2] ?? 'list';

if (cmd === 'list') {
  const rows = (conf.targets ?? []).map((t) => {
    const desc = t.kind === 'weibo_hot' ? `关键词：${(t.keywords ?? []).join('、')}`
      : t.kind === 'bili_dynamic' ? `uid ${t.uid}`
      : t.kind === 'rss' ? t.url : '';
    return `${t.id.padEnd(24)} ${String(t.kind).padEnd(13)} ${t.name ?? ''} ${desc}`;
  });
  console.log(rows.length ? rows.join('\n') : '（还没有订阅）');
  process.exit(0);
}

if (cmd === 'remove') {
  const id = process.argv[3];
  if (!id) { console.error('用法：node tools\\subscribe.mjs remove <id>'); process.exit(1); }
  const before = (conf.targets ?? []).length;
  conf.targets = (conf.targets ?? []).filter((t) => t.id !== id);
  if (conf.targets.length === before) { console.error(`没有这个订阅：${id}`); process.exit(1); }
  save();
  const st = path.join(ROOT, 'qq-bridge', 'state', 'subscriptions-state.json');
  try { const s = JSON.parse(fs.readFileSync(st, 'utf8')); delete s[id]; fs.writeFileSync(st, `${JSON.stringify(s, null, 2)}\n`, 'utf8'); } catch {}
  console.log(`已移除：${id}`);
  process.exit(0);
}

if (cmd === 'add') {
  const kind = String(arg('kind', ''));
  const name = arg('name', '');
  let target = null;
  if (kind === 'weibo_hot') {
    const keywords = String(arg('keywords', '')).split(/[,，、\s]+/).filter(Boolean);
    if (!keywords.length) { console.error('weibo_hot 需要 --keywords "AI,大模型"'); process.exit(1); }
    target = { id: `weibo-${slug(keywords.join('-'))}`, kind, keywords, ...(name ? { name } : {}) };
  } else if (kind === 'bili_dynamic') {
    const uid = Number(arg('uid', 0));
    if (!uid) { console.error('bili_dynamic 需要 --uid'); process.exit(1); }
    target = { id: `bili-${uid}`, kind, uid, ...(name ? { name } : {}) };
  } else if (kind === 'rss') {
    const url = String(arg('url', ''));
    if (!/^https?:\/\//.test(url)) { console.error('rss 需要 --url http(s)://...'); process.exit(1); }
    target = { id: `rss-${slug(name || new URL(url).hostname)}`, kind, url, ...(name ? { name } : {}) };
  } else {
    console.error('--kind 必须是 weibo_hot / bili_dynamic / rss');
    process.exit(1);
  }
  conf.targets = conf.targets ?? [];
  if (conf.targets.some((t) => t.id === target.id)) { console.error(`已存在同名订阅：${target.id}`); process.exit(1); }
  conf.targets.push(target);
  save();
  console.log(`已添加：${target.id}（第一次检查只建基线，不会推送历史）`);
  process.exit(0);
}

console.error('用法：list | add --kind ... | remove <id>');
process.exit(1);
