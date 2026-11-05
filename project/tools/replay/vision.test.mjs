// 回放：视觉辅助模型适配（vision.js）。
// 用假 OpenAI 兼容服务验证请求形状、视频提示词、图片上限、失败降级。

import assert from 'node:assert/strict';
import http from 'node:http';
import { buildVisionMessages, describeVisuals, normalizeVisionConfig } from '../../qq-bridge/src/vision.js';

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

let lastBody = null;
let mode = 'ok';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
    if (mode === 'error') { res.writeHead(500); res.end('{}'); return; }
    if (mode === 'badjson') { res.writeHead(200); res.end('not json'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '画面里有一个蓝发女孩在吃西瓜' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfg = (extra = {}) => ({ socialV2: { vision: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, model: 'minicpm-v-2.6', apiKey: 'k', ...extra } } });

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);

await check('配置解析与默认值', () => {
  const v = normalizeVisionConfig({ socialV2: { vision: { enabled: true } } });
  assert.equal(v.enabled, true);
  assert.equal(v.model, 'minicpm-v-2.6');
  assert.ok(v.timeoutMs >= 5000);
});

await check('未启用 → 直接 null（不请求）', async () => {
  const before = lastBody;
  const r = await describeVisuals({ images: [{ buffer: jpeg, mimeType: 'image/jpeg' }], cfg: { socialV2: { vision: { enabled: false } } } });
  assert.equal(r, null);
  assert.equal(lastBody, before);
});

await check('单图：请求形状正确（data URL + model）', async () => {
  mode = 'ok';
  const r = await describeVisuals({ images: [{ buffer: jpeg, mimeType: 'image/jpeg' }], cfg: cfg() });
  assert.match(r, /蓝发女孩/);
  assert.equal(lastBody.model, 'minicpm-v-2.6');
  const content = lastBody.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.ok(content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
});

await check('视频：使用视频提示词', async () => {
  await describeVisuals({ images: [{ buffer: jpeg, mimeType: 'image/jpeg' }], kind: 'video', cfg: cfg() });
  assert.match(lastBody.messages[0].content[0].text, /时间顺序/);
});

await check('原生视频：video_url + fps/media_resolution', async () => {
  mode = 'ok';
  const buf = Buffer.from('fake-mp4');
  const r = await describeVisuals({ video: { buffer: buf, mimeType: 'video/mp4' }, kind: 'video', cfg: cfg({ videoFps: 1, videoMediaResolution: 'default' }) });
  assert.match(r, /蓝发女孩/);
  const c = lastBody.messages[0].content;
  assert.equal(c[0].type, 'video_url');
  assert.ok(c[0].video_url.url.startsWith('data:video/mp4;base64,'));
  assert.equal(c[0].fps, 1);
  assert.equal(c[0].media_resolution, 'default');
  assert.equal(c[1].type, 'text');
});

await check('nativeVideo=false 时退化为图片帧', async () => {
  const imgs = [{ buffer: jpeg, mimeType: 'image/jpeg' }];
  await describeVisuals({ images: imgs, kind: 'video', cfg: cfg({ nativeVideo: false }) });
  assert.equal(lastBody.messages[0].content[0].type, 'text');
});

await check('图片数量按 maxImages 截断', async () => {
  const imgs = Array.from({ length: 9 }, () => ({ buffer: jpeg, mimeType: 'image/jpeg' }));
  await describeVisuals({ images: imgs, cfg: cfg({ maxImages: 6 }) });
  assert.equal(lastBody.messages[0].content.length, 7); // 1 text + 6 images
});

await check('服务 500 → null（不抛）', async () => {
  mode = 'error';
  const r = await describeVisuals({ images: [{ buffer: jpeg }], cfg: cfg() });
  assert.equal(r, null);
});

await check('坏 JSON → null', async () => {
  mode = 'badjson';
  const r = await describeVisuals({ images: [{ buffer: jpeg }], cfg: cfg() });
  assert.equal(r, null);
});

await check('空内容 → null', async () => {
  mode = 'ok';
  const r = await describeVisuals({ images: [], cfg: cfg() });
  assert.equal(r, null);
});

await check('buildVisionMessages 生成 content 数组', () => {
  const msgs = buildVisionMessages({ images: [{ base64: 'AAA', mimeType: 'image/png' }], prompt: 'p' });
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content[1].image_url.url, 'data:image/png;base64,AAA');
});

server.close();
console.log(`vision replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
