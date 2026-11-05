// 表情库整理：去重、视觉补备注、生成可注入目录、生成每周人工审核报告。
// 每 12 小时由 live-watch 拉起；也可以手动：
//   node tools/sticker-curate.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const STICKERS = path.join(STATE, 'stickers.json');
const HOME = path.join(ROOT, 'agent-home', 'stickers');
const BACKUP = path.join(HOME, 'backups');
const ARCHIVE = path.join(HOME, 'archive');
const REVIEW = path.join(HOME, 'review');
const CATALOG = path.join(HOME, 'catalog.json');
const RUNSTATE = path.join(STATE, 'sticker-curate-state.json');
const LOCK = path.join(STATE, 'sticker-curate.lock');
const LOG = path.join(HOME, 'curate.log');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, f); };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };
const norm = (e) => ({ ...e, id: String(e.id || e.resId || e.md5 || e.url || ''), tags: Array.isArray(e.tags) ? e.tags : [] });
const keyOf = (e) => String(e.md5 || e.url || e.id || '');
const isoWeek = (d = new Date()) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - y) / 86400000) + 1) / 7)).padStart(2, '0')}`; };

function cfg() { return readJson(path.join(ROOT, 'qq-bridge', 'config.json'), {}); }
function lock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (pid && Number.isInteger(pid)) { try { process.kill(pid, 0); return false; } catch {} }
  } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid), 'utf8'); return true; } catch { return false; }
}
function unlock() { try { fs.unlinkSync(LOCK); } catch {} }

async function visionNote(entry, v) {
  if (!entry?.url || !v?.apiKey) return null;
  const res = await fetch(entry.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('image fetch HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 6 * 1024 * 1024) throw new Error('image too large');
  const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + v.apiKey },
    body: JSON.stringify({
      model: v.model || 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看这张 QQ 表情包，只输出 JSON：{"note":"一句话说明什么场景用、传达什么情绪","tags":["2-5个短标签"],"usage":"触发场景"}。不要客套，不要 markdown。' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ] }],
      max_completion_tokens: 220,
      thinking: { type: 'disabled' }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json().catch(() => null);
  const text = String(j?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('vision empty');
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return { note: text.replace(/\s+/g, ' ').slice(0, 80), tags: [], usage: text.slice(0, 120) };
}

async function main() {
  if (!lock()) { log('已有整理任务在运行，跳过'); return; }
  try {
    fs.mkdirSync(BACKUP, { recursive: true }); fs.mkdirSync(ARCHIVE, { recursive: true }); fs.mkdirSync(REVIEW, { recursive: true });
    const list = (readJson(STICKERS, []) || []).map(norm).filter((e) => e.id && e.url);
    if (!list.length) { log('表情库为空'); return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeJson(path.join(BACKUP, `stickers-${stamp}.json`), list);

    // 1) 去重：保留备注更完整、使用次数更高的那条，其余进 archive。
    const byKey = new Map();
    const duplicates = [];
    for (const e of list) {
      const k = keyOf(e);
      if (!byKey.has(k)) { byKey.set(k, e); continue; }
      const a = byKey.get(k);
      const score = (x) => (x.localNote ? 2 : 0) + (x.desc ? 1 : 0) + (Number(x.useCount) || 0);
      if (score(e) > score(a)) { duplicates.push(a); byKey.set(k, e); } else duplicates.push(e);
    }
    if (duplicates.length) writeJson(path.join(ARCHIVE, `duplicates-${stamp}.json`), duplicates);
    let entries = [...byKey.values()];

    // 2) 新表情/缺备注表情做视觉整理；每次最多 12 个，避免一次烧太多。
    const v = cfg().socialV2?.vision || {};
    let visual = 0, visualFail = 0;
    const pendingReview = [];
    for (const e of entries) {
      const needs = !e.localNote || e.needsVision === true || !e.visionCheckedAt;
      if (!needs) continue;
      if (visual >= 12) { pendingReview.push({ ...e, reason: '本轮视觉预算用完' }); continue; }
      try {
        const ann = await visionNote(e, v);
        if (ann) {
          e.localNote = String(ann.note || ann.usage || e.localNote || '').slice(0, 160);
          e.desc = String(ann.usage || e.desc || ann.note || '').slice(0, 40);
          e.tags = Array.isArray(ann.tags) ? ann.tags.map((x) => String(x).slice(0, 20)).filter(Boolean).slice(0, 8) : (e.tags || []);
          e.visionCheckedAt = new Date().toISOString();
          e.needsVision = false;
          visual++;
        } else { visualFail++; pendingReview.push({ ...e, reason: '视觉无结果' }); }
      } catch (err) { visualFail++; pendingReview.push({ ...e, reason: '视觉失败：' + (err?.message ?? err) }); }
    }

    // 3) 按“有备注、使用次数、最近使用”排序，写目录。
    entries.sort((a, b) => ((b.localNote || b.desc) ? 1 : 0) - ((a.localNote || a.desc) ? 1 : 0)
      || (Number(b.useCount) || 0) - (Number(a.useCount) || 0)
      || (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0));
    writeJson(STICKERS, entries);
    writeJson(CATALOG, {
      generatedAt: new Date().toISOString(), count: entries.length, visualThisRun: visual,
      entries: entries.map((e) => ({ id: e.id, desc: e.desc || '', note: e.localNote || '', tags: e.tags || [], useCount: Number(e.useCount) || 0, source: e.source || 'qq' }))
    });

    // 4) 每周人工审核报告（同一周覆盖写）。
    const reviewFile = path.join(REVIEW, `${isoWeek()}.md`);
    const lines = [`# 表情库人工审核 ${isoWeek()}`, '', `生成时间：${new Date().toLocaleString('zh-CN')}`, `总数：${entries.length}`, `本轮视觉整理：${visual}`, `视觉失败：${visualFail}`, ''];
    if (pendingReview.length) {
      lines.push('## 待人工确认', '');
      for (const e of pendingReview.slice(0, 30)) lines.push(`- \`${e.id}\` ${e.localNote || e.desc || '（无备注）'} ← ${e.reason || '需确认'}`);
    } else lines.push('## 待人工确认', '', '无');
    if (duplicates.length) {
      lines.push('', '## 已归档重复项', '');
      for (const e of duplicates.slice(0, 30)) lines.push(`- \`${e.id}\` ${e.localNote || e.desc || ''}`);
    }
    lines.push('', '> 审核方式：直接编辑 stickers.json 的 localNote/tags，或删除不想要的条目；备份在 backups/。');
    fs.writeFileSync(reviewFile, lines.join('\n') + '\n', 'utf8');

    writeJson(RUNSTATE, { lastRunAt: Date.now(), count: entries.length, visual, visualFail, duplicates: duplicates.length });
    log(`整理完成：${entries.length} 个，视觉 ${visual}，失败 ${visualFail}，重复 ${duplicates.length}`);
  } catch (e) {
    log('整理失败：' + (e?.message ?? e));
    process.exitCode = 1;
  } finally { unlock(); }
}

main();
