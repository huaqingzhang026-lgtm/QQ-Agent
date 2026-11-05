// 回放：表情包标注解析与调用。
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseStickerAnnotation, annotateSticker } from '../../qq-bridge/src/sticker-annotate.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

check('标准 JSON', () => {
  const a = parseStickerAnnotation('{"desc":"女孩翻白眼","emotion":"无语","useWhen":"对方说蠢话时","tags":["无语","白眼"]}');
  assert.equal(a.desc, '女孩翻白眼（无语）');
  assert.equal(a.note, '对方说蠢话时；情绪:无语');
  assert.deepEqual(a.tags, ['无语', '白眼']);
});

check('```json 包裹', () => {
  const a = parseStickerAnnotation('```json\n{"desc":"猫猫哭","emotion":"委屈","useWhen":"被欺负时","tags":["委屈"]}\n```');
  assert.match(a.desc, /猫猫哭/);
});

check('前后有废话也能抠出来', () => {
  const a = parseStickerAnnotation('好的，这是结果：{"desc":"狗头","emotion":"嘲讽","useWhen":"阴阳怪气","tags":["狗头"]} 希望有用');
  assert.match(a.desc, /狗头/);
});

check('tags 是逗号字符串也能用', () => {
  const a = parseStickerAnnotation('{"desc":"笑","emotion":"开心","useWhen":"好笑时","tags":"开心,笑死"}');
  assert.deepEqual(a.tags, ['开心', '笑死']);
});

check('非法 JSON → null', () => {
  assert.equal(parseStickerAnnotation('not json'), null);
  assert.equal(parseStickerAnnotation(''), null);
  assert.equal(parseStickerAnnotation(null), null);
});

check('缺字段但有一句 → 可用', () => {
  const a = parseStickerAnnotation('{"useWhen":"接梗时甩"}');
  assert.equal(a.note, '接梗时甩');
});

// 假视觉服务
let lastBody = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"desc":"鲸鱼竖大拇指","emotion":"赞同","useWhen":"同意对方时","tags":["赞同","点赞"]}' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfg = { socialV2: { vision: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, model: 'mimo-v2.6-flash', apiKey: 'k' } } };

const run = async () => {
  const a = await annotateSticker({ buffer: Buffer.from([0xff, 0xd8, 1]), mimeType: 'image/jpeg', cfg });
  assert.ok(a && /鲸鱼/.test(a.desc), '应返回标注');
  const content = lastBody.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /严格 JSON/);
  assert.equal(content[1].type, 'image_url');
  console.log(`sticker-annotate replay: ${pass} 项通过，${fails.length} 项失败`);
  if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
  console.log('全部通过');
  server.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
