import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', 'bili-mcp');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(serverDir, 'run.mjs')],
  cwd: serverDir,
  stderr: 'ignore',
});
const client = new Client({ name: 'p2', version: '1.0.0' });
await client.connect(transport);

for (const [name, args] of [['bilibili_search', { keyword: 'deepseek', page: 1 }], ['bilibili_hot', { page: 1, max: 2 }]]) {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  console.log(`\n### ${name} len=${t.length} hasBV=${/BV[0-9A-Za-z]{10}/.test(t)}`);
  console.log('tail:', t.slice(-400).replace(/\n/g, ' | '));
}
await client.close();
process.exit(0);
