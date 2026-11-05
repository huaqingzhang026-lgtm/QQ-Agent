// 话题钩子：从最近聊天里提炼 3 个"具体可接"的点，避免她开话题时泛泛提问。
//
// 优先用 MiMo 生成；失败/超时时用本地启发式（最近的问题、没说完的话、被提到的人）。

export function heuristicHooks(messages = [], limit = 3) {
  const out = [];
  const list = [...messages].slice(-30).reverse().filter((m) => !m?.isSelf);
  const textOf = (m) => String(m?.text ?? m?.plain ?? '').replace(/\s+/g, ' ').trim();
  const whoOf = (m) => String(m?.sender || '对方').slice(0, 12);
  // 先问题，再具体的事
  for (const m of list) {
    const text = textOf(m);
    if (text.length >= 6 && /[?？]$|吗$|呢$|怎么|为什么|要不要|有没有|谁/.test(text)) {
      out.push(`接 ${whoOf(m)} 的问题：${text.slice(0, 45)}`);
    }
    if (out.length >= limit) return out.slice(0, limit);
  }
  for (const m of list) {
    const text = textOf(m);
    if (text.length >= 6 && /在|刚|今天|昨天|买了|看了|玩了|吃了|去了/.test(text)) {
      out.push(`顺着 ${whoOf(m)} 说的事：${text.slice(0, 45)}`);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export function parseHooks(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  try {
    const s = raw.indexOf('[');
    const e = raw.lastIndexOf(']');
    if (s >= 0 && e > s) {
      const arr = JSON.parse(raw.slice(s, e + 1));
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
    }
  } catch {}
  return raw.split('\n').map((l) => l.replace(/^[-*\d.\s、]+/, '').trim()).filter((l) => l.length >= 4).slice(0, 5);
}

export async function generateTopicHooks({ cfg, messages = [], people = [], limit = 3 } = {}) {
  const v = cfg?.socialV2?.vision ?? {};
  const key = cfg?.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
  const fallback = heuristicHooks(messages, limit);
  if (!key) return fallback;
  const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
  const lines = messages.slice(-40).map((m) => `${m?.isSelf ? '她' : (m?.sender || '某人')}: ${String(m?.text ?? m?.plain ?? '').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
  const prompt = `你在帮一个 18 岁女生找 QQ 群聊里"具体、自然、能接上"的话题。
最近聊天：
${lines || '（最近没人说话）'}

群友已知兴趣：${people.slice(0, 6).join('；') || '（无）'}

给 3 个话题钩子，要求：
1. 必须引用具体的人或具体的事（谁说过什么、什么没聊完），不要空泛；
2. 每个一句话，不超过 40 字；
3. 不要查户口式提问，不要"你们最近看什么/有什么推荐"这类。
只输出 JSON 数组，例如 ["问问A上次那个游戏卡关过没过","接B说的猫，讲自己家的猫"]。`;
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 300, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    const hooks = parseHooks(j?.choices?.[0]?.message?.content).slice(0, limit);
    return hooks.length ? hooks : fallback;
  } catch {
    return fallback;
  }
}
