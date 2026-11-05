// 用视觉模型给表情包打标注：这是什么、什么情绪、什么时候用、标签。
//
// 输出统一成：
//   desc    —— 一句话描述画面（给模型"看懂"用）
//   note    —— 什么时候甩这张（localNote，最重要的检索字段）
//   tags    —— 情绪/场景关键词
//   usage   —— 更具体的使用示例（可空）
//
// 只依赖 vision.js 的 OpenAI 兼容调用，所以换模型只改配置。

import { describeVisuals } from './vision.js';

const PROMPT = `你在给 QQ 表情包打标签，方便以后按场景准确选用。
看这张图，输出**严格 JSON**（不要 markdown 代码块、不要解释），字段：
{
  "desc": "画面是什么：角色/动作/文字，30字内",
  "emotion": "主要情绪：如 得意/无语/嘲笑/委屈/震惊/害羞/摆烂/赞同",
  "useWhen": "什么聊天场景适合甩这张，40字内，要具体",
  "tags": ["3~6个检索词"]
}
只输出这一个 JSON 对象。`;

/** 从模型输出里抠出 JSON（容忍 ```json 包裹或前后废话）。 */
export function parseStickerAnnotation(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const tags = (Array.isArray(obj.tags) ? obj.tags : String(obj.tags ?? '').split(/[,，、\s]+/))
    .map((t) => clean(t, 12)).filter(Boolean).slice(0, 6);
  const desc = clean(obj.desc, 30);
  const emotion = clean(obj.emotion, 12);
  const useWhen = clean(obj.useWhen, 40);
  if (!desc && !useWhen) return null;
  const noteParts = [useWhen, emotion ? `情绪:${emotion}` : ''].filter(Boolean);
  return {
    desc: [desc, emotion ? `（${emotion}）` : ''].filter(Boolean).join('').slice(0, 40),
    note: noteParts.join('；').slice(0, 60),
    tags: tags.length ? tags : (emotion ? [emotion] : []),
    usage: useWhen,
  };
}

/**
 * @param {{buffer: Buffer, mimeType?: string}} image
 * @returns {Promise<{desc:string,note:string,tags:string[],usage:string}|null>}
 */
export async function annotateSticker({ buffer, mimeType = 'image/png', cfg, fetchImpl = globalThis.fetch } = {}) {
  if (!buffer) return null;
  const first = await describeVisuals({ images: [{ buffer, mimeType }], prompt: PROMPT, cfg, fetchImpl });
  const parsed = parseStickerAnnotation(first);
  if (parsed) return parsed;
  // 模型偶尔会回一段解释而不是 JSON：用更严厉的提示再要一次。
  const second = await describeVisuals({
    images: [{ buffer, mimeType }],
    prompt: PROMPT + '\n注意：上一次输出不是合法 JSON。这次只输出一个 JSON 对象，从 { 开始到 } 结束，不要任何其他文字。',
    cfg,
    fetchImpl,
  });
  return parseStickerAnnotation(second);
}
