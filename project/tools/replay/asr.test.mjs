// 回放：ASR（MiMo-V2.5-ASR）适配。
// 假 OpenAI 兼容服务验证 input_audio 形状、语言参数、大小限制与失败降级。

import assert from 'node:assert/strict';
import http from 'node:http';
import { transcribeAudio, normalizeAsrConfig, audioMimeOf } from '../../qq-bridge/src/asr.js';

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
    if (mode === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '这是转写出来的语音内容' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfg = (extra = {}) => ({ socialV2: { asr: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', ...extra } } });

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]);

await check('配置默认值', () => {
  const a = normalizeAsrConfig({ socialV2: { asr: { enabled: true } } });
  assert.equal(a.model, 'mimo-v2.5-asr');
  assert.equal(a.language, 'auto');
});

await check('未启用 → null 且不发请求', async () => {
  const before = lastBody;
  const r = await transcribeAudio({ buffer: mp3, cfg: { socialV2: { asr: { enabled: false } } } });
  assert.equal(r, null);
  assert.equal(lastBody, before);
});

await check('wav 转写：请求形状正确', async () => {
  mode = 'ok';
  const r = await transcribeAudio({ buffer: wav, cfg: cfg() });
  assert.match(r, /转写出来/);
  assert.equal(lastBody.model, 'mimo-v2.5-asr');
  assert.equal(lastBody.asr_options.language, 'auto');
  const c = lastBody.messages[0].content[0];
  assert.equal(c.type, 'input_audio');
  assert.ok(c.input_audio.data.startsWith('data:audio/wav;base64,'));
});

await check('mp3 用 audio/mpeg', async () => {
  await transcribeAudio({ buffer: mp3, cfg: cfg({ language: 'zh' }) });
  const c = lastBody.messages[0].content[0];
  assert.ok(c.input_audio.data.startsWith('data:audio/mpeg;base64,'));
  assert.equal(lastBody.asr_options.language, 'zh');
});

await check('超过 maxBytes → 不请求', async () => {
  const before = JSON.stringify(lastBody);
  const big = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2 * 1024 * 1024)]);
  const r = await transcribeAudio({ buffer: big, cfg: cfg({ maxBytes: 1 }) });
  assert.equal(r, null);
  assert.equal(JSON.stringify(lastBody), before);
});

await check('500 → null', async () => {
  mode = 'error';
  assert.equal(await transcribeAudio({ buffer: mp3, cfg: cfg() }), null);
});

await check('空文本 → null', async () => {
  mode = 'empty';
  assert.equal(await transcribeAudio({ buffer: mp3, cfg: cfg() }), null);
});

await check('文件头识别 wav/mp3', () => {
  assert.equal(audioMimeOf(wav), 'audio/wav');
  assert.equal(audioMimeOf(mp3), 'audio/mpeg');
  assert.equal(audioMimeOf(Buffer.from('xxxx'), 'audio/mpeg'), 'audio/mpeg');
});

server.close();
console.log(`asr replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
