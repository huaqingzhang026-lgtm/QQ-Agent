import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const biliDir = path.resolve(here, '..', 'bili-mcp');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(biliDir, 'guard.mjs')],
  cwd: biliDir,
  stderr: 'ignore',
});
const client = new Client({ name: 'live-probe', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log('tools:', names.length, '| has live_danmaku:', names.includes('bilibili_live_danmaku'));

const WHITELIST_UID = 30001;

async function probe(label, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n');
  console.log(`\n### ${label} | isError=${!!r.isError}`);
  console.log(text.slice(0, 420));
}

await probe('白名单内的直播信息', 'bilibili_live_info', { uid: WHITELIST_UID });
await probe('白名单外 uid', 'bilibili_live_info', { uid: 123456 });
await probe('白名单外发直播弹幕（应拒绝，不发请求）', 'bilibili_live_danmaku', { uid: 123456, message: 'guard-test' });
await probe('白名单内但配额已满（应拒绝，不发请求）', 'bilibili_live_danmaku', { uid: WHITELIST_UID, message: 'guard-test' });

await client.close();
process.exit(0);
