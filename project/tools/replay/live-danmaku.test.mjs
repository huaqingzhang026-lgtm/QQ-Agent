// 回放：直播弹幕额度/协议。
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  capFor, decideDanmaku, noteDanmaku, excuseNeeded, isStreamerTalkingToHer,
  parsePackets, extractDanmaku, hourKey, DEFAULT_QUOTA,
} from '../../qq-bridge/src/live-danmaku-protocol.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const now = 1_792_700_000_000;

check('平时上限 10，互动中 20', () => {
  assert.equal(capFor({ now, quota: {} }), 10);
  assert.equal(capFor({ now, engagedUntil: now + 60000, quota: {} }), 20);
});

check('额度未满 + 间隔够 → 可以发', () => {
  const d = decideDanmaku({ state: { hourKey: hourKey(now), count: 3, lastAt: now - 60000 }, now });
  assert.equal(d.allow, true);
  assert.equal(d.cap, 10);
});

check('到 10 条 → 不能发', () => {
  const d = decideDanmaku({ state: { hourKey: hourKey(now), count: 10, lastAt: now - 60000 }, now });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'cap');
});

check('互动中到 15 条仍可发，到 20 不行', () => {
  const a = decideDanmaku({ state: { hourKey: hourKey(now), count: 15, lastAt: now - 60000 }, now, engagedUntil: now + 60000 });
  assert.equal(a.allow, true);
  const b = decideDanmaku({ state: { hourKey: hourKey(now), count: 20, lastAt: now - 60000 }, now, engagedUntil: now + 60000 });
  assert.equal(b.allow, false);
});

check('间隔不足 30 秒 → 拒绝', () => {
  const d = decideDanmaku({ state: { hourKey: hourKey(now), count: 1, lastAt: now - 5000 }, now });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'gap');
});

check('跨小时计数清零', () => {
  const old = hourKey(now - 3600000);
  const d = decideDanmaku({ state: { hourKey: old, count: 10, lastAt: now - 3600000 }, now });
  assert.equal(d.allow, true);
  assert.equal(d.used, 0);
});

check('noteDanmaku 累加并跨小时重置', () => {
  const s1 = noteDanmaku({ hourKey: hourKey(now), count: 2 }, now, 'hi');
  assert.equal(s1.count, 3);
  const s2 = noteDanmaku({ hourKey: hourKey(now - 3600000), count: 9 }, now, 'hi');
  assert.equal(s2.count, 1);
});

check('到上限且没发过借口 → 需要借口', () => {
  const r = excuseNeeded({ state: { hourKey: hourKey(now), count: 10 }, now });
  assert.equal(r.needed, true);
});

check('发过借口后不再需要', () => {
  const r = excuseNeeded({ state: { hourKey: hourKey(now), count: 10, excuseHour: hourKey(now) }, now });
  assert.equal(r.needed, false);
});

check('主播叫她名字 → 算跟她说话', () => {
  assert.equal(isStreamerTalkingToHer({ text: 'Pluto 你在吗', nameKeywords: ['Pluto', '小鲸鱼'] }), true);
});

check('主播接她上一句 → 算', () => {
  assert.equal(isStreamerTalkingToHer({ text: '刚才说猫猫好可爱的是谁', lastHerTexts: ['猫猫好可爱'] }), true);
});

check('普通弹幕 → 不算', () => {
  assert.equal(isStreamerTalkingToHer({ text: '今天播到几点', nameKeywords: ['Pluto'], lastHerTexts: ['猫猫好可爱'] }), false);
});

check('协议：普通包解析', () => {
  const body = Buffer.from(JSON.stringify({ cmd: 'DANMU_MSG', info: [[], '你好', [12345, '小明']] }), 'utf8');
  const buf = Buffer.alloc(16 + body.length);
  buf.writeUInt32BE(16 + body.length, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(5, 8);
  buf.writeUInt32BE(1, 12);
  body.copy(buf, 16);
  const pkts = parsePackets(buf);
  assert.equal(pkts.length, 1);
  assert.equal(pkts[0].op, 5);
  const d = extractDanmaku(JSON.parse(pkts[0].body.toString('utf8')));
  assert.equal(d.text, '你好');
  assert.equal(d.uid, '12345');
  assert.equal(d.name, '小明');
});

check('协议：zlib 压缩包', () => {
  const innerBody = Buffer.from(JSON.stringify({ cmd: 'DANMU_MSG', info: [[], '压缩弹幕', [1, 'A']] }), 'utf8');
  const inner = Buffer.alloc(16 + innerBody.length);
  inner.writeUInt32BE(16 + innerBody.length, 0);
  inner.writeUInt16BE(16, 4);
  inner.writeUInt16BE(0, 6);
  inner.writeUInt32BE(5, 8);
  inner.writeUInt32BE(1, 12);
  innerBody.copy(inner, 16);
  const z = zlib.deflateSync(inner);
  const outer = Buffer.alloc(16 + z.length);
  outer.writeUInt32BE(16 + z.length, 0);
  outer.writeUInt16BE(16, 4);
  outer.writeUInt16BE(2, 6);
  outer.writeUInt32BE(5, 8);
  outer.writeUInt32BE(1, 12);
  z.copy(outer, 16);
  const pkts = parsePackets(outer);
  assert.equal(extractDanmaku(JSON.parse(pkts[0].body.toString('utf8'))).text, '压缩弹幕');
});

check('非弹幕消息忽略', () => {
  assert.equal(extractDanmaku({ cmd: 'SEND_GIFT', info: [] }), null);
  assert.equal(extractDanmaku({ cmd: 'DANMU_MSG', info: [[], ''] }), null);
});

console.log(`live-danmaku replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
