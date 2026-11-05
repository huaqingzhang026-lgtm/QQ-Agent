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
  env: { ...process.env },
});
const client = new Client({ name: 'subtitle-probe', version: '1.0.0' });
await client.connect(transport);

const search = await client.callTool({ name: 'bilibili_search', arguments: { keyword: 'deepseek', page: 1 } });
const text = (search.content ?? []).map((c) => c.text ?? '').join('\n');
console.log('=== raw search (first 1500) ===');
console.log(text.slice(0, 1500));
const bv = (text.match(/BV[0-9A-Za-z]{10}/) ?? [])[0];
console.log('\npicked bvid:', bv);

if (bv) {
  const info = await client.callTool({ name: 'bilibili_video_info', arguments: { videoId: bv } });
  console.log('\n=== info ===');
  console.log((info.content ?? []).map((c) => c.text ?? '').join('\n').slice(0, 400));

  const sub = await client.callTool({ name: 'bilibili_video_subtitle', arguments: { videoId: bv } });
  console.log('\n=== subtitle ===');
  console.log((sub.content ?? []).map((c) => c.text ?? '').join('\n').slice(0, 500));
}
await client.close();
process.exit(0);
