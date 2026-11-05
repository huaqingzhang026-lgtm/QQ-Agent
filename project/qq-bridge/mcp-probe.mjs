import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'src', 'mcp-snowluma-safe.js')],
  cwd: here,
  stderr: 'inherit',
});
const client = new Client({ name: 'probe', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log('registered tools:', tools.length);
console.log(names.join('\n'));
console.log('\nsend_sticker present:', names.includes('qq_send_sticker'));
await client.close();
process.exit(0);
