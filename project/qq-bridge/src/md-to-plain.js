// 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。
export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏（内容尾部换行去掉，围栏后的换行自然保留一个分隔）
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）。
  // 候选长度必须有界：`[^\]]*` 在大量 "!["（模型被诱导输出）时每次都要扫到串尾，
  // 整体是 O(n²)，会把 QQ 收发/定时器所在的事件循环卡住若干秒。排除换行 + 上限 500
  // 既不影响正常 Markdown，又把每次尝试的代价压成常数。
  s = s.replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/g, '$1 ($2)');
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  // 单个 * 的斜体有两个判定条件，缺一就会被当成普通符号吃掉：
  //   ① 不能跨行（`[^*]+` 会吞换行，把行首 `* ` 列表项和乘法式当成一对标记）；
  //   ② 开标记后、闭标记前都不能是空白（Markdown 的强调分隔符本来就不允许空格贴边），
  //      否则 "2 * 3 * 4" 这种乘法式会被整段删掉。
  s = s.replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + ' ');
  // 表格：按行保留文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 按 QQ 单条消息长度上限切分（群消息一般 ≤ 4500 字，留余量）。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const parts = [];
  let rest = text;
  while (rest.length > safeMax) {
    let cut = rest.lastIndexOf('\n', safeMax - 1);
    let eat = 0;
    if (cut <= 0) {
      cut = safeMax; // 硬切
    } else {
      eat = 1; // 换行符保留给前一段，避免拼接后丢换行
    }
    // 若切点正好落在代理对中间（emoji 等会被切成乱码），把切点前移一个码元
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    // 防止 max=1 且开头是 emoji 代理对时零进度死循环：至少推进一个完整码点。
    if (cut <= 0) {
      const first = rest.charCodeAt(0);
      const second = rest.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
      eat = 0;
    }
    parts.push(rest.slice(0, cut + eat));
    rest = rest.slice(cut + eat);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 截断到最多 `max` 个字符，**绝不切开代理对**。
 *
 * 为什么不直接用 `text.slice(0, max)`：`String.prototype.slice` 按 UTF-16 **码元**切，
 * 而 QQ 里常见的 emoji / 生僻字占**两个**码元。切点正好落在中间时会留下一个孤立高代理
 * ——它不是一个合法字符，写进 JSON、日志、提示词后一律渲染成替换符（�）。
 * 桥接里"截断给人看"的地方很多（记忆、旁观窗口、消息详情、角色卡），全部中招。
 *
 * 语义：上限按**码点**算（对纯 BMP 文本与 slice 完全一致；对含 emoji 的文本只多留不切坏）。
 * 判据与同文件的 splitForQQ、以及 src/forward.js 的预览截断保持一致。
 * `max` 非有限数时返回空串 —— 与 `slice(0, NaN)` 的既有行为一致，不做静默放宽。
 */
export function truncateText(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 切在高代理上：前移一个码元
  if (cut <= 0) { // limit=1 且开头就是代理对：至少保留一个完整码点
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}

/**
 * {@link truncateText} 的尾部版本：保留**最后** `max` 个字符。
 *
 * 对应 `text.slice(-max)` —— 它同样按码元切，只是切点落在**低**代理上：
 * 结果开头会多出一个孤立低代理，同样是坏字符。判据镜像处理。
 */
export function truncateTextTail(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let start = s.length - limit;
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) { // 切点在低代理上
    const before = s.charCodeAt(start - 1);
    // 前面是高代理 ⇒ 这对是一个完整字符，一起留下（宁可多一个码元，也不留孤立代理）；
    // 否则是畸形输入里的孤儿低代理，丢掉它。
    start = (start > 0 && before >= 0xd800 && before <= 0xdbff) ? start - 1 : start + 1;
  }
  return s.slice(start);
}


/** 把一段回复拆成多条 QQ 消息（气泡），模拟真人分条说话。 */
export function splitIntoBubbles(text, { maxParts = 4, maxLineLen = 120 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const safeParts = Math.max(1, Math.min(6, Number(maxParts) || 4));
  // 优先按空行分段
  let parts = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    // 只有“短句行”才按行拆，避免把列表/代码拆坏
    if (lines.length >= 2 && lines.length <= safeParts && lines.every((l) => l.length <= maxLineLen && !/^[-*\d.、]/.test(l))) {
      parts = lines;
    }
  }
  // 没有换行时，按中文句号/问号/感叹号拆句（只拆长回复，避免把一句话拆碎）
  if (parts.length < 2 && raw.length >= 28 && !/https?:\/\//i.test(raw) && !raw.includes('\u0060\u0060\u0060')) {
    const sentences = raw.split(/(?<=[。！？!?…])/u).map((s) => s.trim()).filter(Boolean);
    if (sentences.length >= 2) {
      const grouped = [];
      for (const s of sentences) {
        if (grouped.length && s.length < 8) grouped[grouped.length - 1] += s;
        else grouped.push(s);
      }
      if (grouped.length >= 2) parts = grouped.slice(0, safeParts);
    }
  }
  if (parts.length < 2) return [raw];
  if (parts.length > safeParts) {
    const head = parts.slice(0, safeParts - 1);
    const tail = parts.slice(safeParts - 1).join('\n');
    parts = [...head, tail];
  }
  return parts.map((s) => s.trim()).filter(Boolean);
}

// ── 额度不足时的气泡合并 ────────────────────────────────────────────────
// 发不出那么多条时，原实现用 `.join('，')` 把两条消息拼起来 —— 这是**凭空补标点**：
// 「我不饿」+「你先吃」变成「我不饿，你先吃」，逗号是桥接发明的，不是她写的。
// 合并只允许「把原文拼回去」，分隔符在最坏情况下用换行，绝不用标点。
const TRAILING_SEPARATOR_RE = /[。！？!?…，,、；;：:~～]$/;
const LEADING_SEPARATOR_RE = /^[。！？!?…，,、；;：:~～]/;

/** 把若干气泡拼回一条：已有分隔（空白/标点）就不再补，否则用换行，不补任何标点。 */
export function joinBubbles(parts) {
  const list = (Array.isArray(parts) ? parts : [parts]).map((s) => String(s ?? '')).filter((s) => s !== '');
  if (list.length === 0) return '';
  let out = list[0];
  for (let i = 1; i < list.length; i++) {
    const next = list[i];
    const alreadySeparated = /\s$/.test(out) || /^\s/.test(next)
      || TRAILING_SEPARATOR_RE.test(out) || LEADING_SEPARATOR_RE.test(next);
    out += (alreadySeparated ? '' : '\n') + next;
  }
  return out;
}

/**
 * 按剩余额度把气泡合并到不超过 `room` 条。
 * 与旧的 `.join('，')` 的差别：不新增任何标点，原文内容一字不改。
 */
export function mergeBubblesForQuota(messages, room) {
  const list = (Array.isArray(messages) ? messages : []).map((s) => String(s ?? '')).filter((s) => s.trim() !== '');
  const limit = Math.max(1, Math.floor(Number(room) || 1));
  if (list.length <= limit) return list;
  const per = Math.ceil(list.length / limit);
  const out = [];
  for (let i = 0; i < list.length; i += per) out.push(joinBubbles(list.slice(i, i + per)));
  return out;
}
