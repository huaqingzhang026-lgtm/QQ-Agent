const base = "http://127.0.0.1:18060/mcp";
const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = await fetch(base, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p", version: "1" } } }) });
const sid = init.headers.get("mcp-session-id");
const hh = { ...h, ...(sid ? { "mcp-session-id": sid } : {}) };
const call = await (await fetch(base, { method: "POST", headers: hh, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_login_status", arguments: {} } }) })).json();
console.log(JSON.stringify(call.result?.content ?? call).slice(0, 300));
