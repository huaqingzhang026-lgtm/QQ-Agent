// 回放：QQ 分享卡片解析（手机分享的视频/文章）。
import assert from 'node:assert/strict';
import { parseCardJson, parseCardXml, parseShareCard, formatShareCard, isVideoLink } from '../../qq-bridge/src/share-card.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

check('B站小程序卡片（qqdocurl）', () => {
  const raw = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    meta: { detail_1: { title: '哔哩哔哩', desc: '【猫猫】这视频笑死我了', qqdocurl: 'https://b23.tv/AbCdEf', preview: 'https://pic.example/x.jpg' } },
  });
  const c = parseCardJson(raw);
  assert.equal(c.title, '哔哩哔哩');
  assert.match(c.desc, /猫猫/);
  assert.equal(c.url, 'https://b23.tv/AbCdEf');
});

check('structmsg news 卡片（jumpUrl）', () => {
  const raw = JSON.stringify({
    app: 'com.tencent.structmsg',
    meta: { news: { title: '这个 UP 主更新了', desc: '新视频：三分钟看懂 MiMo', jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' } },
  });
  const c = parseCardJson(raw);
  assert.equal(c.title, '这个 UP 主更新了');
  assert.equal(c.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
});

check('小程序 qqdocurl 被转义也能解', () => {
  const raw = '{"meta":{"detail_1":{"title":"抖音","qqdocurl":"https:\\/\\/v.douyin.com\\/abc123"}}}';
  const c = parseCardJson(raw);
  assert.equal(c.url, 'https://v.douyin.com/abc123');
});

check('XML 卡片', () => {
  const xml = `<?xml version="1.0"?><msg serviceID="1" templateID="1" action="web" url="https://b23.tv/xyz"><item layout="2"><title>【视频】猫猫合集</title><summary>三分钟看完</summary><source name="哔哩哔哩"/></item></msg>`;
  const c = parseCardXml(xml);
  assert.equal(c.title, '【视频】猫猫合集');
  assert.match(c.desc, /三分钟/);
  assert.equal(c.source, '哔哩哔哩');
  assert.equal(c.url, 'https://b23.tv/xyz');
});

check('XML CDATA', () => {
  const xml = `<msg><item><title><![CDATA[标题 & 符号]]></title><summary>描述</summary><url>https://example.com/a</url></item></msg>`;
  const c = parseCardXml(xml);
  assert.match(c.title, /标题 & 符号/);
  assert.equal(c.url, 'https://example.com/a');
});

check('坏数据返回 null', () => {
  assert.equal(parseCardJson('not json'), null);
  assert.equal(parseCardJson('{}'), null);
  assert.equal(parseCardXml(''), null);
  assert.equal(parseShareCard({ type: 'text', data: { text: 'hi' } }), null);
});

check('format：含链接与视频提示', () => {
  const c = parseCardJson(JSON.stringify({ meta: { detail_1: { title: 'B站', qqdocurl: 'https://b23.tv/x' } } }));
  const s = formatShareCard(c);
  assert.match(s, /\[分享卡片\]/);
  assert.match(s, /https:\/\/b23\.tv\/x/);
  assert.match(s, /web_fetch/);
});

check('format：空卡片兜底', () => {
  assert.equal(formatShareCard(null), '[卡片消息]');
});

check('isVideoLink 识别常见平台', () => {
  assert.equal(isVideoLink('https://b23.tv/x'), true);
  assert.equal(isVideoLink('https://www.bilibili.com/video/BV1'), true);
  assert.equal(isVideoLink('https://v.douyin.com/x'), true);
  assert.equal(isVideoLink('https://example.com/a'), false);
});

console.log(`share-card replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
