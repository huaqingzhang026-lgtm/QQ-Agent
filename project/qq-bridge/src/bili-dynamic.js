// B 站动态文案：两种模式
//   sync  —— 与 QQ 空间同一条生活动态，直接同步，不再二次创作
//   video —— 围绕一个 B 站视频写一条真人式短动态，不写影评/总结
import fs from 'node:fs';

const BANNED = /(首先|其次|再次|最后|总的来说|综上|总而言之|不得不说|值得推荐|推荐大家|一方面|另一方面|这让我想到|视频讲了|这个视频告诉我们|可以说是|非常值得|整体来说|不难看出|让人不禁)/;
const STYLE_SAMPLES = [
  '本来只想看五分钟，抬头已经该吃下一顿了。',
  '封面：我懂了。正片：我不懂。',
  '这个转场我反复看了三遍，不是好看，是没看懂怎么接上的。',
  '弹幕比视频还急，我还没反应过来他们已经吵完了。',
  '说不上来哪里好，但就是没划走。',
  '看完只记住一句话，剩下的全忘了。'
];

function sanitize(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/(?:^|\s)@[^\s，。！？、]+/g, ' 朋友')
    .replace(/[（(]?\b\d{5,12}\b[）)]?/g, '')
    .replace(/(?:QQ|qq|群号|ID|id)\s*[:：]?\s*\d+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function clean(text, max = 160) {
  return sanitize(String(text ?? '').replace(/^[\s"“”']+|[\s"“”']+$/g, '').replace(/\s+/g, ' ').trim()).slice(0, max);
}
function bad(text) {
  const t = String(text || '');
  const sentences = (t.match(/[。！？!?]/g) || []).length;
  return !t || t.length < 10 || t.length > 110 || sentences > 3 || BANNED.test(t);
}

function promptFor({ videoContext = {}, recent = [] }) {
  const v = videoContext || {};
  const detail = [v.title, v.up ? `UP：${v.up}` : '', v.summary, v.danmaku].filter(Boolean).join('；').slice(0, 900);
  return `你是 18 岁女生 Pluto，正在刷 B 站。现在发一条 B 站动态，不是 QQ 空间。
只写一条，30-80 字，最多 2 句。像普通用户刷视频时随手发的，不要写成影评、观后感或总结。
从下面的真实素材里只抓一个具体点：${detail || '一个你刚看到的画面'}
可选语气（选一种，不要照抄样本）：${STYLE_SAMPLES.map((x) => '「' + x + '」').join(' ')}
硬性要求：
- 只写一个具体反应、一个画面或一句吐槽；不要总结视频内容，不要评价“值不值得看”，不要推荐。
- 禁止词语：首先、其次、总的来说、综上、总而言之、不得不说、值得、推荐、一方面、另一方面、这让我想到、视频讲了、这个视频告诉我们。
- 不要提 AI、模型、代码、桥接、任务、系统；不要写群友昵称、QQ号、群号、@、链接。
- 不要每篇都用“今天刷到”“最近看了”开头。
最近 B 站动态（必须换主题和句式）：${(recent || []).slice(-5).join(' / ').slice(0, 400) || '（无）'}
只输出动态正文。`;
}

async function callModel(cfg, prompt) {
  const astra = cfg?.socialV2?.qzone?.astra;
  if (astra?.apiKey) {
    const base = String(astra.baseUrl || 'https://relay.example.invalid/v1').replace(/\/+$/, '');
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + astra.apiKey },
      body: JSON.stringify({ model: astra.model || 'gpt-6-astra', messages: [{ role: 'user', content: prompt }], max_tokens: 260, reasoning_effort: 'low' }),
      signal: AbortSignal.timeout(45000),
    });
    const j = await r.json().catch(() => null);
    return clean(j?.choices?.[0]?.message?.content);
  }
  const v = cfg?.socialV2?.vision || {};
  const key = cfg?.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  if (!key) return '';
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 220, thinking: { type: 'disabled' } }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => null);
  return clean(j?.choices?.[0]?.message?.content);
}

export async function generateBiliDynamicTextV2({ cfg, mode = 'video', qzoneText = '', videoContext = {}, recent = [] } = {}) {
  const q = clean(qzoneText, 120);
  if (mode === 'sync') return q ? sanitize(q) : '';
  let text = '';
  try {
    text = await callModel(cfg, promptFor({ videoContext, recent }));
    if (bad(text)) {
      const stricter = promptFor({ videoContext, recent }) + '\n上一次不合格：太长、超过两句或出现总结/推荐词。这次只写一句具体反应，最多 45 字，禁止“值得/推荐/总的来说/视频讲了”。';
      text = await callModel(cfg, stricter);
    }
  } catch { text = ''; }
  return bad(text) ? '' : sanitize(text);
}

export function biliDynamicStyleExamples() { return STYLE_SAMPLES.slice(); }
