// bili-local MCP：绕过 B 站 WBI 风控的只读兜底工具。
//
// 为什么需要：官方 bilibili MCP 的 videoInfo/subtitle 走 WBI，cookie 失效或 -352 时
// 会直接报“WBI 鉴权失败”。这里用公开的 x/web-interface/view、x/v2/reply、player/v2，
// 拿不到官方字幕时再用音频 ASR 兜底。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveBiliLink, formatBiliInfo, transcribeBiliAudio } from '../../tools/bili-link.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8')); } catch { return {}; } })();

const server = new McpServer({ name: 'bili-local', version: '1.0.0' });

server.tool('bili_video_detail', '解析 B 站链接/BV 号，返回标题、UP、简介、热评（不走 WBI）', {
  text: z.string().min(1).max(500),
}, async ({ text }) => {
  try {
    const info = await resolveBiliLink(text, { root: ROOT });
    if (!info?.ok) throw new Error(info?.reason || '解析失败');
    return { content: [{ type: 'text', text: formatBiliInfo(info) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('bili_video_subtitles', '取 B 站字幕；没有官方字幕时用音频 ASR 兜底（可能较慢）', {
  text: z.string().min(1).max(500),
  maxMinutes: z.number().int().min(1).max(30).optional(),
}, async ({ text, maxMinutes }) => {
  try {
    const info = await resolveBiliLink(text, { root: ROOT });
    if (!info?.ok) throw new Error(info?.reason || '解析失败');
    if (info.subtitle) return { content: [{ type: 'text', text: info.subtitle.slice(0, 4000) }] };
    const transcript = await transcribeBiliAudio({ root: ROOT, bvid: info.bvid, cid: info.cid, aid: info.aid, cfg });
    return { content: [{ type: 'text', text: transcript || '没有官方字幕，音频转写也没有拿到内容。' }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

server.tool('bili_video_comments', '取 B 站视频热评（不走 WBI）', {
  text: z.string().min(1).max(500),
}, async ({ text }) => {
  try {
    const info = await resolveBiliLink(text, { root: ROOT });
    if (!info?.ok) throw new Error(info?.reason || '解析失败');
    return { content: [{ type: 'text', text: (info.comments || []).join('\n') || '没有热评' }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
});

await server.connect(new StdioServerTransport());
