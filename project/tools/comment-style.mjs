// B 站评论区风格学习：从真实热评里总结“这个评论区怎么说话”，供生成评论时参考。
import fs from 'node:fs';
import path from 'node:path';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v) + '\n', 'utf8'); } catch {} };

export async function ensureCommentStyle({ stateDir, fullCfg, log }) {
  const styleFile = path.join(stateDir, 'bili-comment-style.json');
  const samplesFile = path.join(stateDir, 'bili-comment-samples.json');
  const old = readJson(styleFile, null);
  if (old && Date.now() - Number(old.updatedAt || 0) < 12 * 3600 * 1000 && old.summary) return old.summary;
  const samples = readJson(samplesFile, []);
  if (!Array.isArray(samples) || samples.length < 20) return old?.summary || '';
  try {
    const v = fullCfg.socialV2?.vision ?? {};
    const key = fullCfg.socialV2?.tts?.apiKey || v.apiKey || process.env.MIMO_API_KEY || '';
    if (!key) return old?.summary || '';
    const base = String(v.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/v1$/, '');
    const prompt = '下面是 B 站评论区的真实评论。总结这个评论区怎么说话：句子长短、语气、常用梗/黑话、emoji 和标点习惯、常见的接话方式。输出不超过 250 字，只输出总结。\n\n' + samples.slice(-200).join('\n').slice(0, 7000);
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: v.model || 'mimo-v2.6-flash', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 350, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await r.json().catch(() => null);
    const summary = String(j?.choices?.[0]?.message?.content ?? '').trim();
    if (summary) {
      writeJson(styleFile, { summary: summary.slice(0, 700), updatedAt: Date.now(), samples: samples.length });
      if (log) log('B站评论风格已更新');
    }
    return summary || old?.summary || '';
  } catch { return old?.summary || ''; }
}

export function appendCommentSamples({ stateDir, comments }) {
  const file = path.join(stateDir, 'bili-comment-samples.json');
  const old = readJson(file, []);
  const arr = Array.isArray(old) ? old : [];
  arr.push(...comments.map((c) => String(c?.text ?? '').trim()).filter(Boolean));
  writeJson(file, arr.slice(-500));
}
