// 群规候选提取（S6.3）：从群公告里抽出"像规则"的句子，写成待确认清单。
//
// 边界（behavior-spec §5）：
//   · 只提取候选，**绝不自动改工具权限或行为**；
//   · 管理员确认后才算生效（confirmed 列表由人维护）；
//   · 原始公告仍以 group-info.json 为准，本文件只是派生视图。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'qq-bridge', 'state');
const NOTES = path.join(ROOT, 'agent-home', 'notes');
const INFO = path.join(STATE, 'group-info.json');
const OUT_JSON = path.join(STATE, 'group-rules.json');

const RULE_HINT = /(请勿|禁止|不许|不要|严禁|违者|禁言|踢出|举报|拉黑|不得|勿)/;
const NOISE = /(欢迎|感谢|祝|活动|抽奖|开播|粉丝|舰长|礼物|群号)/;

/** 从一段公告文本里抽候选规则（纯函数，便于测试）。 */
export function extractRules(text, { max = 30 } = {}) {
  const raw = String(text ?? '')
    .replace(/&#10;/g, '\n')
    .replace(/\r/g, '')
    .split(/\n|[；;]/)
    .map((s) => s.replace(/^[\s\d、.．)）\-*•]+/, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of raw) {
    if (line.length < 6 || line.length > 200) continue;
    if (!RULE_HINT.test(line)) continue;
    if (NOISE.test(line) && !RULE_HINT.test(line)) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}


const isMainModule = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && pathToFileURL(entry).href === import.meta.url;
  } catch { return false; }
})();

function main() {
  const info = (() => { try { return JSON.parse(fs.readFileSync(INFO, 'utf8')); } catch { return {}; } })();
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')); } catch { return {}; } })();

  const result = { updatedAt: new Date().toISOString(), groups: {} };
  fs.mkdirSync(NOTES, { recursive: true });

  for (const [key, v] of Object.entries(info)) {
    const notices = (v.notices ?? []).map((n) => n.text ?? '').join('\n');
    const candidates = extractRules(notices);
    if (!candidates.length) continue;
    const confirmed = Array.isArray(prev?.groups?.[key]?.confirmed) ? prev.groups[key].confirmed : [];
    result.groups[key] = { candidates, confirmed };

    const gid = key.replace(/^group:/, '');
    const md = [
      `# 群规候选 · ${key}`,
      '',
      `从群公告提取了 **${candidates.length}** 条候选规则；**未生效**，需管理员确认后写入 confirmed。`,
      '',
      '## 候选',
      ...candidates.map((c, i) => `${i + 1}. ${c}`),
      '',
      '## 已确认',
      ...(confirmed.length ? confirmed.map((c, i) => `${i + 1}. ${c}`) : ['（暂无）']),
      '',
      '> 确认方式：把要生效的条目复制到 `state/group-rules.json` 的 `confirmed` 数组，再由管理员在人格/配置里体现。脚本不会自动改权限。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(NOTES, `群规候选-${gid}.md`), md, 'utf8');
  }

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const groups = Object.keys(result.groups).length;
  const total = Object.values(result.groups).reduce((a, g) => a + g.candidates.length, 0);
  console.log(`群规候选：${groups} 个群，共 ${total} 条 → ${path.relative(ROOT, OUT_JSON)}`);

}

if (isMainModule) main();
