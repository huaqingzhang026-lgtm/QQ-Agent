// 每周把稳定 >=7 天、未被回滚的 evolution 改动合并回 persona 单一源。
// 合并后运行 persona-build 重新生成 agent.cordis.yml；DSH 下次重启生效。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state', 'persona-evolution.json');
const PROMPT = path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'persona.prompt.txt');
const LOG = path.join(ROOT, 'qq-bridge', 'state', 'persona-merge.log');
const DAY = 24 * 60 * 60 * 1000;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {} };

const s = read(STATE, { changes: [], version: 0 });
const now = Date.now();
if (now - Number(s.lastMergeAt || 0) < 7 * DAY && !process.argv.includes('--force')) { log('未到 7 天合并窗口，跳过'); process.exit(0); }
const eligible = (s.changes || []).filter((c) => !c.mergedAt && now - Number(c.at || 0) >= 7 * DAY);
if (!eligible.length) { log('没有稳定 >=7 天的改动，跳过'); s.lastMergeAt = now; fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', 'utf8'); process.exit(0); }

const backup = PROMPT + '.bak-' + Date.now();
try { fs.copyFileSync(PROMPT, backup); } catch (e) { log('备份失败：' + (e?.message ?? e)); process.exit(1); }
const block = '\n\n## 人格演化合并（' + new Date().toISOString().slice(0, 10) + '）\n\n' + eligible.map((c) => `- ${String(c.section || '变化')}：${String(c.content || '').slice(0, 600)}`).join('\n') + '\n';
try {
  fs.appendFileSync(PROMPT, block, 'utf8');
  const build = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'persona-build.mjs')], { cwd: ROOT, timeout: 120000, windowsHide: true, encoding: 'utf8' });
  if (build.status !== 0) throw new Error('persona-build 失败：' + String(build.stderr || build.stdout || '').slice(0, 300));
  for (const c of eligible) c.mergedAt = now;
  s.lastMergeAt = now;
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', 'utf8');
  log(`已合并 ${eligible.length} 项稳定人格变化；备份 ${path.basename(backup)}；DSH 下次重启生效`);
} catch (e) {
  try { fs.copyFileSync(backup, PROMPT); } catch {}
  log('合并失败，已恢复：' + (e?.message ?? e));
  process.exit(1);
}
