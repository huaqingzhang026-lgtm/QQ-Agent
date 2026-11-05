// 回放：直播音频切片与转写。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { takeCompletedSegments, transcribeSegment, listSegments } from '../../qq-bridge/src/live-audio.js';

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-audio-'));

await check('只取已写完的切片（排除最新一片）', () => {
  for (let i = 0; i < 3; i++) {
    const f = path.join(dir, `seg-0000${i}.mp3`);
    fs.writeFileSync(f, Buffer.alloc(5000, 1));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(f, old, old);
  }
  const done = takeCompletedSegments(dir, new Set(), { minAgeMs: 3000 });
  assert.equal(done.length, 2, `got ${done.length}`);
});

await check('已处理过的不再返回', () => {
  const done = takeCompletedSegments(dir, new Set(['seg-00000.mp3']), { minAgeMs: 3000 });
  assert.deepEqual(done.map((d) => d.name), ['seg-00001.mp3']);
});

await check('太小的文件跳过', () => {
  const f = path.join(dir, 'seg-00003.mp3');
  fs.writeFileSync(f, Buffer.alloc(100, 1));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f, old, old);
  const done = takeCompletedSegments(dir, new Set(), { minAgeMs: 3000 });
  assert.ok(!done.some((d) => d.name === 'seg-00003.mp3'));
});

await check('listSegments 排序', () => {
  assert.deepEqual(listSegments(dir).slice(0, 3), ['seg-00000.mp3', 'seg-00001.mp3', 'seg-00002.mp3']);
});

// 假转写服务
let lastBody = null;
let mode = 'ok';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
    if (mode === 'error') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '主播说：这把稳了' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfg = { socialV2: { vision: { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'mimo-v2.6-flash' } } };

await check('转写请求形状', async () => {
  mode = 'ok';
  const text = await transcribeSegment(Buffer.from('fake-mp3'), { cfg });
  assert.match(text, /主播说/);
  const c = lastBody.messages[0].content;
  assert.equal(c[0].type, 'input_audio');
  assert.ok(c[0].input_audio.data.startsWith('data:audio/mpeg;base64,'));
  assert.match(c[1].text, /转写/);
});

await check('没有 key → 空字符串', async () => {
  const text = await transcribeSegment(Buffer.from('x'), { cfg: { socialV2: {} } });
  assert.equal(text, '');
});

await check('服务 500 → 空字符串', async () => {
  mode = 'error';
  assert.equal(await transcribeSegment(Buffer.from('x'), { cfg }), '');
});

await check('空音频 → 空字符串', async () => {
  assert.equal(await transcribeSegment(Buffer.alloc(0), { cfg }), '');
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
server.close();
console.log(`live-audio replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
