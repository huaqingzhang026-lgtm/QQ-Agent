// 演示用小 MCP：验证 tools/add-mcp.mjs 的握手/安装/卸载链路。
import readline from 'node:readline';

const TOOLS = [
  { name: 'demo_ping', description: '演示工具：返回 pong 和当前时间。', inputSchema: { type: 'object', properties: {} } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo-mcp', version: '0.0.1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `pong ${new Date().toISOString()}` }] } });
  else if (msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
});
