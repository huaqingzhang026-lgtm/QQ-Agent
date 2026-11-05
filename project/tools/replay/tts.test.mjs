// 回放：TTS（MiMo-V2.5-TTS）适配。
// 假 OpenAI 兼容服务验证 messages 角色、风格指令、音色参数、音频解析与落盘。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { synthesizeSpeech, extractAudioBase64, saveSpeechToLibrary, normalizeTtsConfig } from '../../qq-bridge/src/tts.js';

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const AUDIO = Buffer.from('fake-mp3-bytes');
let lastBody = null;
let mode = 'ok';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
    if (mode === 'error') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', audio: { data: AUDIO.toString('base64'), format: 'mp3' } } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfg = (extra = {}) => ({ socialV2: { tts: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', ...extra } } });

await check('默认配置', () => {
  const t = normalizeTtsConfig({});
  assert.equal(t.model, 'mimo-v2.5-tts');
  assert.equal(t.voice, '冰糖');
});

await check('未启用 → null', async () => {
  const r = await synthesizeSpeech({ text: '你好', cfg: { socialV2: { tts: { enabled: false } } } });
  assert.equal(r, null);
});

await check('请求形状：assistant 放正文、user 放风格', async () => {
  const r = await synthesizeSpeech({ text: '我回来啦', cfg: cfg({ voice: '茉莉' }) });
  assert.ok(r.buffer.equals(AUDIO));
  assert.equal(lastBody.model, 'mimo-v2.5-tts');
  assert.equal(lastBody.messages[0].role, 'user');
  assert.equal(lastBody.messages[1].role, 'assistant');
  assert.equal(lastBody.messages[1].content, '我回来啦');
  assert.equal(lastBody.audio.voice, '茉莉');
});

await check('自定义风格指令', async () => {
  await synthesizeSpeech({ text: '哼', style: '用不耐烦的语气', cfg: cfg() });
  assert.equal(lastBody.messages[0].content, '用不耐烦的语气');
});

await check('正文超长截断到 maxChars', async () => {
  await synthesizeSpeech({ text: '字'.repeat(500), cfg: cfg({ maxChars: 20 }) });
  assert.equal(lastBody.messages[1].content.length, 20);
});

await check('500 → null', async () => {
  mode = 'error';
  assert.equal(await synthesizeSpeech({ text: 'hi', cfg: cfg() }), null);
});

await check('extractAudioBase64 兼容多种形状', () => {
  assert.equal(extractAudioBase64({ choices: [{ message: { audio: { data: 'AAA' } } }] }), 'AAA');
  assert.equal(extractAudioBase64({ data: 'BBB' }), 'BBB');
  assert.equal(extractAudioBase64({ data: [{ b64_json: 'CCC' }] }), 'CCC');
  assert.equal(extractAudioBase64({ choices: [{ message: { content: 'data:audio/mp3;base64,DDD' } }] }), 'DDD');
  assert.equal(extractAudioBase64({}), '');
});

await check('保存到语音库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const file = saveSpeechToLibrary(dir, Buffer.from('x'), 'mp3', '我回来啦');
  assert.ok(fs.existsSync(file));
  assert.match(path.basename(file), /\.mp3$/);
  assert.ok(path.basename(file).includes('我回来啦') || path.basename(file).length > 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

server.close();
console.log(`tts replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
