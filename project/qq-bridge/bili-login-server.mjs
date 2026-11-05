// B 站扫码登录的"活二维码"页面。
//
// 为什么需要：B 站登录二维码只有 ~180 秒 TTL，而聊天里发一张静态图，
// 等用户看到/去拿手机，经常就过期了。这里起一个本地 HTTP 服务：
//   GET /        -> 页面，图片每 5 秒自动刷新（带 cache-buster）
//   GET /qr.png  -> 当前二维码（内存里渲染，不落盘）
//   GET /status  -> JSON 状态
// 后台每 120 秒重新生成一次二维码，并持续轮询扫码状态；
// 一旦确认登录就写 cookie.json，页面显示"登录成功"。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import QRCode from 'qrcode';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const biliDir = path.resolve(here, '..', 'bili-mcp');
const wrapper = path.join(biliDir, 'run.mjs');
const cookieFile = path.join(biliDir, 'cookie.json');
const PORT = 3111;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [wrapper],
  cwd: biliDir,
  stderr: 'inherit',
  env: { ...process.env, BILIBILI_COOKIE_FILE: cookieFile, BILIBILI_AUTO_REFRESH: 'false' },
});
const client = new Client({ name: 'login-page', version: '1.0.0' });
await client.connect(transport);

const state = {
  status: 'pending',   // pending | scanned | ok | expired | error
  message: '等待扫码',
  png: null,
  url: '',
  key: '',
  updatedAt: 0,
  cookieWritten: false,
};

async function regenerate() {
  if (state.status === 'ok') return;
  try {
    const r = await client.callTool({ name: 'bilibili_login', arguments: {} });
    const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
    const urlMatch = text.match(/https?:\/\/\S+/);
    const keyMatch = text.match(/qrcode_key=([a-f0-9]+)/) ?? text.match(/"loginKey":\s*"([^"]+)"/);
    if (!urlMatch || !keyMatch) throw new Error('解析二维码失败');
    state.url = urlMatch[0];
    state.key = keyMatch[1];
    state.png = await QRCode.toBuffer(state.url, { width: 480, margin: 1 });
    state.status = 'pending';
    state.message = '等待扫码（二维码已刷新）';
    state.updatedAt = Date.now();
    console.log('[login] 已生成新二维码', new Date().toLocaleTimeString());
  } catch (e) {
    state.status = 'error';
    state.message = '生成二维码失败: ' + e.message;
    console.error(e.message);
  }
}

async function poll() {
  if (state.status === 'ok' || !state.key) return;
  try {
    const res = await client.callTool({ name: 'bilibili_login_check', arguments: { loginKey: state.key, maxRetries: 1 } });
    const t = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
    if (!res.isError && /成功|已登录|保存/.test(t)) {
      const saved = fs.existsSync(cookieFile);
      console.log('[login] 原始返回:', t.slice(0, 300));
      if (saved) {
        state.status = 'ok';
        state.message = '登录成功，cookie 已保存';
        state.cookieWritten = true;
      } else {
        // 常见：'登录成功，但未获取到 SESSDATA' —— 说明扫码确认了但没下发 cookie
        state.status = 'error';
        state.message = '扫码已确认，但没拿到 cookie：' + t.replace(/\s+/g, ' ').slice(0, 120);
        state.cookieWritten = false;
      }
      return;
    }
    if (/过期/.test(t)) {
      state.status = 'expired';
      state.message = '已过期，正在换新…';
      await regenerate();
      return;
    }
    if (/已扫码|待确认|扫描/.test(t)) {
      state.status = 'scanned';
      state.message = '已扫码，请在手机上点确认';
    } else {
      state.message = '等待扫码';
    }
  } catch (e) {
    state.message = '轮询出错: ' + e.message;
  }
}

await regenerate();
setInterval(poll, 2000);
setInterval(() => { if (state.status !== 'ok') regenerate(); }, 120000);

const PAGE = (s) => `<!doctype html><meta charset="utf-8">
<title>B站登录</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#111;color:#eee;
      display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
 .qr{background:#fff;padding:16px;border-radius:12px}
 .st{margin-top:16px;font-size:18px}
 .st.ok{color:#4ade80}.st.scanned{color:#fbbf24}.st.expired{color:#f87171}
 .hint{margin-top:8px;color:#888;font-size:13px}
</style>
<div class="qr"><img id="q" src="/qr.png?t=0" width="360" height="360" alt="登录二维码"></div>
<div class="st ${s.status}" id="st">${s.message}</div>
<div class="hint">二维码每 2 分钟自动换新；页面每 5 秒自动刷新，不用手动操作</div>
<script>
setInterval(()=>{document.getElementById('q').src='/qr.png?t='+Date.now()},5000);
setInterval(async()=>{try{const r=await fetch('/status',{cache:'no-store'});const j=await r.json();
 const el=document.getElementById('st');el.textContent=j.message;el.className='st '+j.status;}catch(e){}},2000);
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/qr.png') {
    if (!state.png) { res.writeHead(503); res.end('no qr yet'); return; }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(state.png);
    return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: state.status, message: state.message, updatedAt: state.updatedAt, cookieWritten: state.cookieWritten }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PAGE(state));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[login] 打开 http://127.0.0.1:${PORT} 扫码（二维码自动续期）`);
});
