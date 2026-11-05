import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const token = process.argv[2];
const key = process.argv[3] ?? 'private:10001';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'src', 'mcp-snowluma-safe.js')],
  cwd: here,
  stderr: 'inherit',
});
const client = new Client({ name: 'probe', version: '1.0.0' });
await client.connect(transport);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.map((c) => c.text ?? `[${c.type}]`).join('\n') ?? '';
  console.log(`\n### ${name} -> isError=${!!r.isError}`);
  console.log(text.slice(0, 700));
}

await call('qq_qzone_my_posts', { key, token, num: 3 });
await call('qq_qzone_feeds', { key, token, count: 3 });
// 越权用例：非白名单好友 → 应被拒且不产生任何写入
await call('qq_qzone_comment', { key, token, tid: 'deadbeef0000000000000000', content: 'test', targetUin: 999999 });
// 越权用例：非 owner 会话 → 应被拒
await call('qq_qzone_post', { key: 'private:123456', token, content: 'should not be posted' });

await client.close();
process.exit(0);
