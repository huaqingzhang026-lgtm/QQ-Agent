// 语音合成（MiMo-V2.5-TTS）：给她"自己的声音"。
//
// 接口是 /chat/completions：
//   · role=assistant 放要念的正文；
//   · role=user 放风格指令（自然语言，如"用轻快、稍微撒娇的语气"）；
//   · audio.voice 选预置音色（冰糖/茉莉/Mia…）。
// 返回里取 base64 音频（audio.data），保存到语音库再走现有发送链路。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT = 60000;

export function normalizeTtsConfig(cfg) {
  const t = cfg?.socialV2?.tts ?? {};
  return {
    enabled: t.enabled === true,
    baseUrl: String(t.baseUrl || cfg?.socialV2?.vision?.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    model: String(t.model || 'mimo-v2.5-tts'),
    apiKey: String(t.apiKey || process.env.MIMO_API_KEY || ''),
    voice: String(t.voice || '冰糖'),
    style: String(t.style || '用18岁女生自然、口语化、稍微可爱的语气说，语速偏快，不要播音腔。'),
    format: String(t.format || 'mp3'),
    timeoutMs: Math.max(5000, Number(t.timeoutMs) || DEFAULT_TIMEOUT),
    maxChars: Math.max(10, Math.min(500, Number(t.maxChars) || 200)),
  };
}

/** 从响应里提取音频 base64（兼容几种常见形状）。 */
export function extractAudioBase64(j) {
  const msg = j?.choices?.[0]?.message;
  if (typeof msg?.audio?.data === 'string' && msg.audio.data) return msg.audio.data;
  if (typeof msg?.content === 'string' && msg.content.startsWith('data:audio/')) {
    return msg.content.split(',')[1] || '';
  }
  if (typeof j?.data === 'string' && j.data) return j.data;
  if (j?.data?.[0]?.b64_json) return j.data[0].b64_json;
  return '';
}

/**
 * @returns {Promise<{buffer: Buffer, format: string}|null>}
 */
export async function synthesizeSpeech({ text, style, cfg, fetchImpl = globalThis.fetch } = {}) {
  const t = normalizeTtsConfig(cfg);
  const bodyText = String(text ?? '').trim().slice(0, t.maxChars);
  if (!t.enabled || !bodyText) return null;
  const body = {
    model: t.model,
    messages: [
      { role: 'user', content: String(style || t.style) },
      { role: 'assistant', content: bodyText },
    ],
    audio: { voice: t.voice, format: t.format },
    max_completion_tokens: 4096,
    thinking: { type: 'disabled' },
    stream: false,
  };
  try {
    const res = await fetchImpl(`${t.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const b64 = extractAudioBase64(j);
    if (!b64) return null;
    return { buffer: Buffer.from(b64, 'base64'), format: t.format };
  } catch {
    return null;
  }
}

/** 存到语音库（文件名带时间和文本前缀），返回绝对路径。 */
export function saveSpeechToLibrary(dir, buffer, format, text, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(text ?? '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 12) || 'speech';
  const file = path.join(dir, `${stamp}-${slug}.${format === 'wav' ? 'wav' : 'mp3'}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
}
