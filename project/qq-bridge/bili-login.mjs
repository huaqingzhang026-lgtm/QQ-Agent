// 生成 B 站扫码登录二维码，并把 qrcode_key 存下来供下一步轮询。
// 用法：node bili-login.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const biliDir = path.resolve(here, '..', 'bili-mcp');
const wrapper = path.join(biliDir, 'run.mjs');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [wrapper],
  cwd: biliDir,
  stderr: 'ignore',
  env: { ...process.env, BILIBILI_COOKIE_FILE: path.join(biliDir, 'cookie.json'), BILIBILI_AUTO_REFRESH: 'false' },
});
const client = new Client({ name: 'login-helper', version: '1.0.0' });
await client.connect(transport);

const r = await client.callTool({ name: 'bilibili_login', arguments: {} });
const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
console.log(text);

const urlMatch = text.match(/https?:\/\/\S+/);
const keyMatch = text.match(/"loginKey":\s*"([^"]+)"/) ?? text.match(/([a-f0-9]{32})/);
if (!urlMatch || !keyMatch) {
  console.error('没能从返回里解析出二维码 URL / loginKey');
  process.exit(1);
}
const url = urlMatch[0];
const key = keyMatch[1];

const png = path.join(biliDir, 'login-qr.png');
await QRCode.toFile(png, url, { width: 480, margin: 1 });
fs.writeFileSync(path.join(biliDir, 'qr.json'), JSON.stringify({ url, key, createdAt: Date.now() }, null, 2));
console.log('QR ->', png);
console.log('key ->', key);

await client.close();
process.exit(0);
