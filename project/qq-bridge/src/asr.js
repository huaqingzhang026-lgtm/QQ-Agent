// 语音识别（MiMo-V2.5-ASR）：把收到的语音/视频音轨转成文字。
//
// 接口与文本模型同一个 /chat/completions，只是 content 里放 input_audio：
//   { type: 'input_audio', input_audio: { data: 'data:audio/mp3;base64,...' } }
// 音频仅支持 wav/mp3，Base64 后 ≤10MB；asr_options.language 可选 auto/zh/en。

const DEFAULT_TIMEOUT = 45000;

export function normalizeAsrConfig(cfg) {
  const a = cfg?.socialV2?.asr ?? {};
  return {
    enabled: a.enabled === true,
    baseUrl: String(a.baseUrl || cfg?.socialV2?.vision?.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    model: String(a.model || 'mimo-v2.5-asr'),
    apiKey: String(a.apiKey || process.env.MIMO_API_KEY || ''),
    language: String(a.language || 'auto'),
    timeoutMs: Math.max(5000, Number(a.timeoutMs) || DEFAULT_TIMEOUT),
    maxBytes: Math.max(1, Math.min(10, Number(a.maxBytes) || 10)) * 1024 * 1024,
  };
}

/** 按文件头猜 mime（只支持 wav/mp3）。 */
export function audioMimeOf(buffer, fallback = 'audio/mpeg') {
  if (!buffer || buffer.length < 4) return fallback;
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'audio/wav';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mpeg';
  return fallback;
}

/**
 * @returns {Promise<string|null>} 转写文本；失败返回 null
 */
export async function transcribeAudio({ buffer, mimeType, cfg, fetchImpl = globalThis.fetch } = {}) {
  const a = normalizeAsrConfig(cfg);
  if (!a.enabled || !buffer || buffer.length === 0) return null;
  if (buffer.length > a.maxBytes) return null;
  const mime = audioMimeOf(buffer, mimeType || 'audio/mpeg');
  if (mime !== 'audio/wav' && mime !== 'audio/mpeg') return null;
  const body = {
    model: a.model,
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${buffer.toString('base64')}` } }],
    }],
    asr_options: { language: a.language },
    max_completion_tokens: 2048,
    thinking: { type: 'disabled' },
  };
  try {
    const res = await fetchImpl(`${a.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(a.apiKey ? { authorization: `Bearer ${a.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(a.timeoutMs),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}
