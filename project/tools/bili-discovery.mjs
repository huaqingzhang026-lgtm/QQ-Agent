// B 站兴趣发现：她自己选兴趣 + 随机内容源（热门分页 / 分区排行 / 相关推荐）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_INTERESTS = [
  { name: '游戏', weight: 3 }, { name: '猫', weight: 2 }, { name: '音乐', weight: 2 },
  { name: '二次元', weight: 2 }, { name: '科技', weight: 1 }, { name: '美食', weight: 1 },
];

export const RID_BY_INTEREST = {
  游戏: 4, 单机游戏: 17, 网络游戏: 65, 电子竞技: 171,
  动画: 1, 二次元: 1, 鬼畜: 119, 音乐: 3, 舞蹈: 129,
  生活: 160, 美食: 211, 动物: 75, 猫: 75, 科技: 188, 知识: 36, 学习: 36,
  影视: 181, 电影: 181, 剧集: 181, 时尚: 155, 运动: 234, 汽车: 223, 手工: 174,
};

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); } catch {} };

export async function ensureInterests({ stateDir, root, fullCfg, log, today }) {
  const file = path.join(stateDir, 'bili-interests.json');
  const old = readJson(file, null);
  if (old?.date === today && Array.isArray(old.interests) && old.interests.length) return old.interests;
  let interests = DEFAULT_INTERESTS;
  try {
    const v = fullCfg.socialV2?.vision ?? {};
    const key = fullCfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
    if (key) {
      let persona = '';
      let diary = '';
      try { persona = fs.readFileSync(path.join(root, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'persona.prompt.txt'), 'utf8').slice(0, 1200); } catch {}
      try { diary = fs.readFileSync(path.join(root, 'agent-home', 'notes', 'daily', today + '.md'), 'utf8').slice(-800); } catch {}
      const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
      const prompt = '你是 18 岁女生 Pluto。根据你的人设和最近的生活，选出你今天最想在 B 站刷的 4-6 个兴趣方向，并给权重（1-3）。要具体（比如“单机游戏”“猫咪”“独立音乐”，不要只写“生活”）。只输出 JSON 数组：[{"name":"...","weight":2}]。\n\n人设：' + persona + '\n最近：' + diary;
      const r = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 300, thinking: { type: 'disabled' } }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      const txt = String(j?.choices?.[0]?.message?.content ?? '');
      const s = txt.indexOf('[');
      const e = txt.lastIndexOf(']');
      if (s >= 0 && e > s) {
        const arr = JSON.parse(txt.slice(s, e + 1));
        const cleaned = arr
          .map((x) => ({ name: String(x?.name ?? '').trim(), weight: Math.max(1, Math.min(3, Number(x?.weight) || 1)) }))
          .filter((x) => x.name)
          .slice(0, 6);
        if (cleaned.length >= 3) interests = cleaned;
      }
    }
  } catch {}
  // 把周兴趣发现转正的长期兴趣合并进来；不删除当天模型生成的兴趣。
  try {
    const pf = path.join(root, 'agent-home', 'memory', 'profile', 'interests.json');
    const p = readJson(pf, { interests: [] });
    const map = new Map(interests.map((x) => [x.name, x]));
    for (const x of (p.interests || [])) if (x?.status === 'active' && x.name) map.set(x.name, { name: x.name, weight: Math.max(1, Math.min(3, Number(x.weight) || 1)) });
    interests = [...map.values()].slice(0, 8);
  } catch {}
  writeJson(file, { date: today, interests, updatedAt: Date.now() });
  log('今日 B 站兴趣：' + interests.map((x) => x.name + '(' + x.weight + ')').join('、'));
  return interests;
}

export function pickWeighted(interests) {
  const total = interests.reduce((a, x) => a + Math.max(1, Number(x.weight) || 1), 0);
  let r = Math.random() * total;
  for (const x of interests) {
    r -= Math.max(1, Number(x.weight) || 1);
    if (r <= 0) return x.name;
  }
  return interests[0]?.name ?? '游戏';
}

export async function popularPage(jsonFetch, pn) {
  const j = await jsonFetch('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=' + pn);
  return j?.data?.list ?? [];
}

export async function rankingByRid(jsonFetch, rid) {
  const j = await jsonFetch('https://api.bilibili.com/x/web-interface/ranking/v2?rid=' + rid + '&type=all');
  return j?.data?.list ?? [];
}

export async function relatedTo(jsonFetch, bvid) {
  const j = await jsonFetch('https://api.bilibili.com/x/web-interface/archive/related?bvid=' + bvid);
  return j?.data ?? [];
}


/** 复合兴趣名（如“猫咪日常”）也能映射到分区。 */
export function ridFor(name) {
  const n = String(name || '');
  if (RID_BY_INTEREST[n]) return RID_BY_INTEREST[n];
  for (const [k, rid] of Object.entries(RID_BY_INTEREST)) {
    if (n.includes(k) || k.includes(n)) return rid;
  }
  return null;
}
