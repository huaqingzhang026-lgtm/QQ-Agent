// 视觉辅助模型（可接 MiniCPM-V 2.6 / MiMo-VL 等）——只负责"看图/看视频帧"，输出文字描述。
//
// 为什么不直接换主模型：主模型（deepseek-flash）要负责聊天、工具调用、人格；
// 视觉模型只做一件事——把画面转成结构化描述（人物、动作、场景、文字/OCR、情绪），
// 再作为【画面描述】注入主模型 prompt。这样：
//   · 视频 4~6 帧能被"按时间顺序"理解成一段话；
//   · 主模型不必为每张图消耗大量视觉 token；
//   · 视觉模型可以随时换（本地 GGUF 或任意 OpenAI 兼容 API）。

const DEFAULT_TIMEOUT = 45000;

export function normalizeVisionConfig(cfg) {
  const v = cfg?.socialV2?.vision ?? {};
  return {
    enabled: v.enabled === true,
    baseUrl: String(v.baseUrl || 'http://127.0.0.1:11437').replace(/\/+$/, ''),
    model: String(v.model || 'minicpm-v-2.6'),
    apiKey: String(v.apiKey || process.env.MIMO_API_KEY || ''),
    timeoutMs: Math.max(5000, Number(v.timeoutMs) || DEFAULT_TIMEOUT),
    maxImages: Math.max(1, Math.min(8, Number(v.maxImages) || 6)),
    nativeVideo: v.nativeVideo !== false,
    videoFps: Math.max(0.2, Math.min(5, Number(v.videoFps) || 1)),
    videoMediaResolution: String(v.videoMediaResolution === 'max' ? 'max' : 'default'),
    maxVideoBytes: Math.max(1, Math.min(80, Number(v.maxVideoBytes) || 20)) * 1024 * 1024,
    /** 视频帧的提示词与单图不同：要求按时间顺序讲变化。 */
    imagePrompt: String(v.imagePrompt || '用中文详细描述这张图：人物/物体、动作、场景、画面里的文字（原样抄写）、明显情绪或梗。200 字以内，不要客套。'),
    videoPrompt: String(v.videoPrompt || '用中文描述这段视频：发生了什么、人物在做什么、场景、画面文字、情绪变化。250 字以内，按时间顺序说，不要逐帧罗列。'),
  };
}

/** 把图片缓冲拼成 OpenAI 兼容的 content 数组。 */
export function buildVisionMessages({ images, video, prompt, model, videoFps = 1, videoMediaResolution = 'low' }) {
  const content = [];
  if (video?.base64 || video?.url) {
    const url = video.url ? String(video.url) : `data:${video.mimeType || 'video/mp4'};base64,${video.base64}`;
    content.push({ type: 'video_url', video_url: { url }, fps: videoFps, media_resolution: videoMediaResolution });
  }
  content.push({ type: 'text', text: String(prompt || '') });
  for (const img of Array.isArray(images) ? images : []) {
    const b64 = Buffer.isBuffer(img?.buffer) ? img.buffer.toString('base64') : String(img?.base64 || '');
    if (!b64) continue;
    const mime = String(img?.mimeType || 'image/jpeg');
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  }
  return [{ role: 'user', content }];
}

/**
 * 调用视觉模型，返回纯文本描述；失败返回 null（调用方决定是否降级）。
 * @param {{images: Array<{buffer?: Buffer, base64?: string, mimeType?: string}>, kind?: 'image'|'video', cfg?: object, fetchImpl?: Function}} opts
 */
export async function describeVisuals({ images, video = null, kind = 'image', prompt = '', cfg, fetchImpl = globalThis.fetch } = {}) {
  const v = normalizeVisionConfig(cfg);
  if (!v.enabled) return null;
  const list = (Array.isArray(images) ? images : []).slice(0, v.maxImages);
  if (!list.length && !video) return null;
  let videoPayload = null;
  if (video && v.nativeVideo) {
    const b64 = video.buffer ? video.buffer.toString('base64') : String(video.base64 || '');
    if (b64 && (!video.buffer || video.buffer.length <= v.maxVideoBytes)) {
      videoPayload = { base64: b64, mimeType: video.mimeType || 'video/mp4' };
    } else if (video.url) {
      videoPayload = { url: String(video.url) };
    }
  }
  const messages = buildVisionMessages({
    images: videoPayload ? [] : list,
    video: videoPayload,
    prompt: prompt || (kind === 'video' ? v.videoPrompt : v.imagePrompt),
    videoFps: v.videoFps,
    videoMediaResolution: v.videoMediaResolution,
  });
  try {
    const res = await fetchImpl(`${v.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(v.apiKey ? { authorization: `Bearer ${v.apiKey}` } : {}) },
      body: JSON.stringify({ model: v.model, messages, max_completion_tokens: 1024, thinking: { type: 'disabled' }, stream: false }),
      signal: AbortSignal.timeout(v.timeoutMs),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}
