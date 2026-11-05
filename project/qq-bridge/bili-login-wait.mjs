// 生成 B 站登录二维码，并在后台持续轮询，扫码确认后自动落盘 cookie。
// 用法：node bili-login-wait.mjs [本文件路径]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const biliDir = path.resolve(here, '..', 'bili-mcp');
const wrapper = path.join(biliDir, 'run.mjs');
const cookieFile = path.join(biliDir, 'cookie.json');
const png = path.join(biliDir, 'login-qr.png');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [wrapper],
  cwd: biliDir,
  stderr: 'ignore',
  env: { ...process.env, BILIBILI_COOKIE_FILE: cookieFile, BILIBILI_AUTO_REFRESH: 'false' },
});
const client = new Client({ name: 'login-waiter', version: '1.0.0' });
await client.connect(transport);

const r = await client.callTool({ name: 'bilibili_login', arguments: {} });
const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
const urlMatch = text.match(/https?:\/\/\S+/);
const keyMatch = text.match(/qrcode_key=([a-f0-9]+)/) ?? text.match(/"loginKey":\s*"([^"]+)"/);
if (!urlMatch || !keyMatch) {
  console.error('解析二维码失败:', text.slice(0, 200));
  process.exit(1);
}
const url = urlMatch[0];
const key = keyMatch[1];

await QRCode.toFile(png, url, { width: 480, margin: 1 });
fs.writeFileSync(path.join(biliDir, 'qr.json'), JSON.stringify({ url, key, createdAt: Date.now() }, null, 2));
console.log('QR ready at', new Date().toLocaleTimeString(), '->', png);

// 轮询：B 站二维码大约 180 秒过期，这里每 2 秒查一次，最多 85 次（170 秒）
let lastStatus = '';
for (let i = 0; i < 85; i++) {
  await new Promise((r2) => setTimeout(r2, 2000));
  let res;
  try {
    res = await client.callTool({ name: 'bilibili_login_check', arguments: { loginKey: key, maxRetries: 1 } });
  } catch (e) {
    console.log('check error:', e.message);
    continue;
  }
  const t = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
  if (!res.isError && /成功|已登录|保存/.test(t)) {
    console.log('\n=== 登录成功 ===');
    console.log(t.slice(0, 300));
    const exists = fs.existsSync(cookieFile);
    console.log('cookie.json 存在:', exists, exists ? `(${fs.statSync(cookieFile).size} bytes)` : '');
    break;
  }
  if (/过期/.test(t)) {
    console.log('\n=== 二维码已过期 ===');
    break;
  }
  if (t !== lastStatus) {
    lastStatus = t;
    console.log('[' + new Date().toLocaleTimeString() + '] ' + t.replace(/\s+/g, ' ').slice(0, 80));
  }
}

await client.close();
process.exit(0);
