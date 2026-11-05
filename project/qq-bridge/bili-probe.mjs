import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', 'bili-mcp');
const entry = path.join(serverDir, 'run.mjs');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: serverDir,
  stderr: 'inherit',
  env: { ...process.env },
});
const client = new Client({ name: 'probe', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('tools:', tools.length);
console.log(tools.map((t) => t.name).join(', '));

for (const [name, args] of [['bilibili_hot', { page: 1, max: 3 }], ['bilibili_search', { keyword: 'deepseek', page: 1 }]]) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.map((c) => c.text ?? `[${c.type}]`).join('\n') ?? '';
    console.log(`\n=== ${name} ===`);
    console.log(text.slice(0, 600));
  } catch (e) {
    console.log(`\n${name} failed: ${e.message}`);
  }
}
await client.close();
process.exit(0);
