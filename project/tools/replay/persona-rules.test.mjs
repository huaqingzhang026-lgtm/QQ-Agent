// 回放：人格版本指纹 + 群规候选提取。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPersona } from '../../tools/persona-version.mjs';
import { extractRules } from '../../tools/group-rules.mjs';
import { renderPersona } from '../../tools/persona-build.mjs';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

check('人格哈希稳定', () => {
  assert.equal(hashPersona('a\nb'), hashPersona('a\nb'));
});
check('人格哈希随内容变化', () => {
  assert.notEqual(hashPersona('a'), hashPersona('a '));
});
check('空内容也有哈希', () => {
  assert.equal(hashPersona('').length, 64);
});

const notice = [
  '欢迎各位舰长加入！感谢大家的支持！',
  '1、请勿讨论其他主播！除非群主主动提及！',
  '2、禁止发涩图。',
  '3、请不要在群里吵架',
  '违规者禁言3天起。',
  '祝大家都能赚大钱爆大米！',
].join('\n');

check('抽出规则句', () => {
  const r = extractRules(notice);
  assert.ok(r.some((x) => x.includes('请勿讨论其他主播')));
  assert.ok(r.some((x) => x.includes('禁止发涩图')));
});
check('过滤欢迎/祝福噪声', () => {
  const r = extractRules(notice);
  assert.ok(!r.some((x) => x.startsWith('欢迎')));
  assert.ok(!r.some((x) => x.includes('赚大钱')));
});
check('支持 &#10; 换行', () => {
  const r = extractRules('请勿在群里搬屎&#10;禁止拉踩其他主播');
  assert.equal(r.length, 2);
});
check('过短的行被丢弃', () => {
  assert.deepEqual(extractRules('禁止'), []);
});
check('去重', () => {
  const r = extractRules('请不要在群里吵架\n请不要在群里吵架');
  assert.equal(r.length, 1);
});
check('上限生效', () => {
  const many = Array.from({ length: 50 }, (_, i) => `请勿做第${i}件事`).join('\n');
  assert.equal(extractRules(many, { max: 10 }).length, 10);
});
check('空输入返回空数组', () => {
  assert.deepEqual(extractRules(''), []);
  assert.deepEqual(extractRules(null), []);
});
check('序号/项目符号被剥掉', () => {
  const r = extractRules('1、请勿讨论其他主播');
  assert.equal(r[0], '请勿讨论其他主播');
});

check('渲染：缩进与换行正确', () => {
  const out = renderPersona('a:\n{{PERSONA_PROMPT_BLOCK}}\nb:\n', '第一行\n\n第二行');
  assert.ok(out.includes('      第一行'));
  assert.ok(out.includes('      第二行'));
  assert.ok(!out.includes('{{PERSONA_PROMPT_BLOCK}}'));
});

check('渲染：空行不补缩进', () => {
  const out = renderPersona('x:\n{{PERSONA_PROMPT_BLOCK}}\n', 'A\n\nB');
  assert.ok(out.split('\n').some((l) => l === ''));
});

check('渲染：保留 CRLF 风格', () => {
  const out = renderPersona('x:\r\n{{PERSONA_PROMPT_BLOCK}}\r\n', 'A\r\nB\r\n');
  assert.ok(out.includes('      A\r\n'));
});

console.log(`persona/rules replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
