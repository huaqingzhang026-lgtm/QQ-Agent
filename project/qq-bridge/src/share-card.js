// QQ 分享卡片解析：手机分享的视频/文章/音乐，在 OneBot 里通常是 json / xml 段，
// 而不是真正的 video/image。她原来只看到 "[卡片消息]"，拿不到链接。
//
// 目标：从卡片里抽出「来源 / 标题 / 简介 / 链接」，变成一句可读文本，
// 让主模型能直接用 web_fetch / bilibili 等工具继续看。

const VIDEO_HOSTS = /(bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com|youtube\.com|youtu\.be|v\.qq\.com|weishi\.qq\.com|xhslink\.com|xiaohongshu\.com|weibo\.(com|cn)|ixigua\.com|kuaishou\.com)/i;

function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function stripTags(s) {
  return unescapeHtml(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstUrl(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s"'<>\\]+/i);
  return m ? m[0].replace(/\\\//g, '/') : '';
}

/** 递归找第一个形如 url 的字段。 */
function findUrl(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return '';
  const keys = ['jumpUrl', 'qqdocurl', 'url', 'preview', 'jump_url', 'docUrl'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v.replace(/\\\//g, '/'))) return v.replace(/\\\//g, '/');
  }
  for (const v of Object.values(obj)) {
    const hit = findUrl(v, depth + 1);
    if (hit) return hit;
  }
  return '';
}

export function isVideoLink(url) {
  return VIDEO_HOSTS.test(String(url ?? ''));
}

/** 解析 json 卡片（QQ 结构消息、小程序、音乐等）。 */
export function parseCardJson(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try { obj = JSON.parse(text); } catch {
      const url = firstUrl(text);
      return url ? { kind: 'card', source: '', title: '', desc: '', url } : null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const meta = obj.meta ?? {};
  const pick = (...cands) => {
    for (const c of cands) if (c && typeof c === 'string' && c.trim()) return c.trim();
    return '';
  };
  const news = meta.news ?? meta.detail_1 ?? meta.detail ?? meta.music ?? meta.video ?? {};
  const title = pick(news.title, obj.prompt, meta.title, obj.title);
  const desc = pick(news.desc, news.summary, meta.desc, meta.summary);
  const source = pick(meta.source, news.source, meta.app_name, obj.app);
  const url = pick(news.jumpUrl, news.qqdocurl, news.preview, news.url, findUrl(meta), findUrl(obj));
  if (!title && !desc && !url) return null;
  return { kind: 'card', source: String(source || '').slice(0, 30), title: String(title).slice(0, 80), desc: String(desc).slice(0, 120), url };
}

/** 解析 xml 卡片。 */
export function parseCardXml(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const get = (tag) => {
    const m = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? stripTags(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')) : '';
  };
  const title = get('title');
  const desc = get('summary') || get('descr');
  const src = text.match(/<source[^>]*name="([^"]*)"/i);
  const url = get('url') || firstUrl(text);
  if (!title && !desc && !url) return null;
  return { kind: 'card', source: src ? stripTags(src[1]).slice(0, 30) : '', title: title.slice(0, 80), desc: desc.slice(0, 120), url };
}

/** 任意段 → 卡片信息。 */
export function parseShareCard(seg) {
  const type = String(seg?.type ?? '');
  const d = seg?.data ?? {};
  const raw = d.data ?? d.content ?? '';
  if (type === 'json') return parseCardJson(raw);
  if (type === 'xml') return parseCardXml(raw);
  if (type === 'light_app') return parseCardJson(raw) ?? parseCardXml(raw);
  return null;
}

/** 卡片 → 给模型看的一行文本。 */
export function formatShareCard(info) {
  if (!info) return '[卡片消息]';
  const bits = [];
  if (info.source) bits.push(`来源：${info.source}`);
  if (info.title) bits.push(`标题：${info.title}`);
  if (info.desc && info.desc !== info.title) bits.push(`简介：${info.desc}`);
  if (info.url) bits.push(`链接：${info.url}`);
  if (!bits.length) return '[卡片消息]';
  const hint = info.url && isVideoLink(info.url)
    ? '（视频链接：可直接用 web_fetch 打开看标题/简介，B站链接可用 bilibili 工具解析）'
    : '';
  return `[分享卡片] ${bits.join(' | ')}${hint}`;
}
