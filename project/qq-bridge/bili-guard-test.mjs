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
  stderr: 'inherit',
});
const client = new Client({ name: 'guard-test', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools through guard:', tools.length);

const r = await client.callTool({
  name: 'bilibili_reply',
  arguments: { videoId: 'BV1xx411c7mD', message: 'guard-test-should-not-send' },
});
console.log('callTool isError =', !!r.isError);
console.log(r.content?.map((c) => c.text ?? `[${c.type}]`).join('\n').slice(0, 300));

await client.close();
process.exit(0);
