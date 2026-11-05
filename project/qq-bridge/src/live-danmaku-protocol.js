// 直播弹幕：协议解析 + 发言额度策略（纯函数，便于回放）。
//
// 额度规则（2026-10-23）：
//   · 主播没跟她说话：每小时 ≤10 条；
//   · 主播跟她说话（提到名字/接她的话）后 10 分钟内：上限提到 20 条/小时；
//   · 到上限：发一条"借口"就闭嘴，这一小时不再发；
//   · 最小间隔 30 秒，避免刷屏。

import zlib from 'node:zlib';

export const DEFAULT_QUOTA = {
  maxPerHour: 10,
  maxPerHourEngaged: 20,
  engagedWindowMs: 10 * 60 * 1000,
  minGapMs: 30 * 1000,
  excuseLines: ['有点事，先溜了', '去忙了，晚点再来', '先撤了，你们玩', '下了下了，回头见'],
};

export function hourKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
}

/** 当前这一小时的上限。 */
export function capFor({ engagedUntil = 0, now = Date.now(), quota = {} } = {}) {
  const q = { ...DEFAULT_QUOTA, ...quota };
  return now < Number(engagedUntil) ? q.maxPerHourEngaged : q.maxPerHour;
}

/**
 * 能不能发。
 * @returns {{allow: boolean, reason: string, cap: number, used: number}}
 */
export function decideDanmaku({ state = {}, now = Date.now(), quota = {}, engagedUntil = 0 } = {}) {
  const q = { ...DEFAULT_QUOTA, ...quota };
  const cap = capFor({ engagedUntil, now, quota: q });
  const hour = hourKey(now);
  const used = state.hourKey === hour ? Number(state.count) || 0 : 0;
  if (used >= cap) return { allow: false, reason: 'cap', cap, used };
  const gap = now - Number(state.lastAt || 0);
  if (state.lastAt && gap < q.minGapMs) return { allow: false, reason: 'gap', cap, used, waitMs: q.minGapMs - gap };
  return { allow: true, reason: 'ok', cap, used };
}

/** 记录一次发送，返回新 state。 */
export function noteDanmaku(state = {}, now = Date.now(), text = '') {
  const hour = hourKey(now);
  const used = state.hourKey === hour ? Number(state.count) || 0 : 0;
  return { hourKey: hour, count: used + 1, lastAt: now, lastText: String(text ?? '').slice(0, 80) };
}

/** 这一小时是否已经发过"借口"。 */
export function excuseNeeded({ state = {}, now = Date.now(), engagedUntil = 0, quota = {} } = {}) {
  const q = { ...DEFAULT_QUOTA, ...quota };
  const cap = capFor({ engagedUntil, now, quota: q });
  const hour = hourKey(now);
  const used = state.hourKey === hour ? Number(state.count) || 0 : 0;
  const sent = state.excuseHour === hour;
  return { needed: used >= cap && !sent, hour, sent };
}

/** 主播的话是不是在跟她说话（叫名字 / 接她上一句）。 */
export function isStreamerTalkingToHer({ text = '', nameKeywords = [], lastHerTexts = [] } = {}) {
  const t = String(text ?? '');
  if (!t) return false;
  for (const k of nameKeywords) {
    if (k && t.includes(String(k))) return true;
  }
  for (const mine of lastHerTexts.slice(-5)) {
    const s = String(mine ?? '').trim();
    if (s.length >= 4 && t.includes(s.slice(0, Math.min(6, s.length)))) return true;
  }
  return false;
}

// ── 协议 ──────────────────────────────────────────────────────────────────

const HEADER = 16;

/** 解一个 TCP 包（可能含多个子包，压缩包递归解）。 */
export function parsePackets(buffer) {
  const out = [];
  let off = 0;
  while (off + HEADER <= buffer.length) {
    const total = buffer.readUInt32BE(off);
    const headerLen = buffer.readUInt16BE(off + 4) || HEADER;
    const ver = buffer.readUInt16BE(off + 6);
    const op = buffer.readUInt32BE(off + 8);
    if (total < headerLen || off + total > buffer.length) break;
    let body = buffer.subarray(off + headerLen, off + total);
    if (ver === 2) {
      try { body = zlib.inflateSync(body); } catch { body = Buffer.alloc(0); }
      out.push(...parsePackets(body));
    } else if (ver === 3) {
      try { body = zlib.brotliDecompressSync(body); } catch { body = Buffer.alloc(0); }
      out.push(...parsePackets(body));
    } else {
      out.push({ op, ver, body });
    }
    off += total;
  }
  return out;
}

/** 从 DANMU_MSG 的 JSON 里取 uid/昵称/文本。 */
export function extractDanmaku(obj) {
  if (!obj || obj.cmd !== 'DANMU_MSG') return null;
  const info = obj.info ?? [];
  const text = String(info?.[1] ?? '').trim();
  const uid = String(info?.[2]?.[0] ?? '');
  const name = String(info?.[2]?.[1] ?? '');
  if (!text) return null;
  return { uid, name, text, at: Date.now() };
}
