// 把一条 QQ 语音消息转成文字（走 SnowLuma 取文件 → SILK 解码 → Whisper）。
//
// 用法：node tools\voice-in.mjs --message <messageId> [--model small]
//       node tools\voice-in.mjs --file 某个语音.bin     # 只测解码/转写，不碰 QQ
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeMessage } from '../voice-mcp/transcribe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const messageId = arg('message', null);
if (!messageId || messageId === true) {
  console.error('用法：node tools\\voice-in.mjs --message <messageId>');
  process.exit(1);
}
try {
  const { wav, text } = await transcribeMessage(String(messageId), String(arg('model', 'large-v3-turbo')));
  console.log(`wav: ${wav}`);
  console.log(text || '（没转出文字）');
} catch (e) {
  console.error(`失败：${e.message}`);
  process.exit(1);
}

