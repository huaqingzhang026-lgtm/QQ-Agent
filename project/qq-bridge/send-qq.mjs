// 给"自主生命"用的 QQ 发送助手：统一走桥接 /api/outbound/notify。
// 这样消息会进入 social-v2 与 memory.sqlite，当前 QQ 会话也能看到。
// 用法：node send-qq.mjs "想说的话"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const owner = cfg.ownerQQ;
const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.error('用法: node send-qq.mjs "想说的话"'); process.exit(2); }
if (!owner) { console.error('config.json 里没有 ownerQQ'); process.exit(2); }

const token = (() => { try { return fs.readFileSync(path.join(here, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; } })();
const base = String(process.env.HER_BRIDGE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
try {
  const res = await fetch(base + '/api/outbound/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
    body: JSON.stringify({ key: 'private:' + owner, text, exempt: true, record: true }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok !== true) throw new Error(j.error || ('HTTP ' + res.status));
  console.log('已通过桥接发送 message_id=' + (j.messageId ?? '?') + (j.recorded ? '（已记录）' : ''));
} catch (e) {
  console.error('发送失败（桥接不可用，未回退直连）：' + (e?.message ?? e));
  process.exit(1);
}
