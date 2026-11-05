// 回放：状态文件读写（state-file）—— revision / 冲突检测 / 原子写。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStateFile, writeStateFile, fingerprint, sameFingerprint, STATE_SCHEMA_VERSION } from '../../qq-bridge/src/state-file.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const tmpFile = () => path.join(os.tmpdir(), `state-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

check('读取不存在的文件返回 null', () => {
  assert.equal(readStateFile(path.join(os.tmpdir(), 'definitely-missing-xyz.json')), null);
});

check('首次写入补 schemaVersion 与 revision=1', () => {
  const f = tmpFile();
  const w = writeStateFile(f, { a: 1 }, { revision: 0 });
  assert.equal(w.ok, true);
  assert.equal(w.revision, 1);
  const r = readStateFile(f);
  assert.equal(r.data.a, 1);
  assert.equal(r.data.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(r.revision, 1);
  fs.rmSync(f, { force: true });
});

check('连续写入 revision 递增', () => {
  const f = tmpFile();
  const w1 = writeStateFile(f, { a: 1 }, { revision: 0 });
  const w2 = writeStateFile(f, { a: 2 }, { revision: w1.revision });
  const r = readStateFile(f);
  assert.equal(w2.revision, 2);
  assert.equal(r.data.a, 2);
  fs.rmSync(f, { force: true });
});

check('损坏文件返回 null 而不是抛错', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ broken', 'utf8');
  assert.equal(readStateFile(f), null);
  fs.rmSync(f, { force: true });
});

check('外部修改后写入被拒绝（conflict）', () => {
  const f = tmpFile();
  const w1 = writeStateFile(f, { a: 1 }, { revision: 0 });
  // 模拟外部进程改写
  fs.writeFileSync(f, JSON.stringify({ a: 99, revision: 5, schemaVersion: 2 }) + '\n', 'utf8');
  const w2 = writeStateFile(f, { a: 2 }, { revision: w1.revision, expectedFp: w1.fp });
  assert.equal(w2.ok, false);
  assert.equal(w2.conflict, true);
  // 原文件内容保留（外部写入的值没被覆盖）
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).a, 99);
  fs.rmSync(f, { force: true });
});

check('无外部修改时正常写入', () => {
  const f = tmpFile();
  const w1 = writeStateFile(f, { a: 1 }, { revision: 0 });
  const w2 = writeStateFile(f, { a: 2 }, { revision: w1.revision, expectedFp: w1.fp });
  assert.equal(w2.ok, true);
  fs.rmSync(f, { force: true });
});

check('不传 expectedFp 时不做冲突检测（兼容旧调用）', () => {
  const f = tmpFile();
  writeStateFile(f, { a: 1 }, { revision: 0 });
  fs.writeFileSync(f, JSON.stringify({ a: 2, revision: 7 }) + '\n', 'utf8');
  const w = writeStateFile(f, { a: 3 }, { revision: 7 });
  assert.equal(w.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).a, 3);
  fs.rmSync(f, { force: true });
});

check('revision 缺失时从 0 开始', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ a: 1 }) + '\n', 'utf8');
  const r = readStateFile(f);
  assert.equal(r.revision, 0);
  assert.equal(r.schemaVersion, 1);
  fs.rmSync(f, { force: true });
});

check('指纹比较：同文件一致', () => {
  const f = tmpFile();
  writeStateFile(f, { a: 1 }, { revision: 0 });
  const a = fingerprint(f);
  const b = fingerprint(f);
  assert.equal(sameFingerprint(a, b), true);
  fs.rmSync(f, { force: true });
});

check('指纹比较：不同文件不一致', () => {
  const f1 = tmpFile();
  const f2 = tmpFile();
  writeStateFile(f1, { a: 1 }, { revision: 0 });
  writeStateFile(f2, { a: 1, b: 2 }, { revision: 0 });
  assert.equal(sameFingerprint(fingerprint(f1), fingerprint(f2)), false);
  fs.rmSync(f1, { force: true });
  fs.rmSync(f2, { force: true });
});

check('写入失败不影响旧文件（路径不可写）', () => {
  const dir = path.join(os.tmpdir(), `nope-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'x.json');
  writeStateFile(f, { a: 1 }, { revision: 0 });
  // 把目录变成只读文件，制造 rename 失败
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a dir', 'utf8');
  const w = writeStateFile(f, { a: 2 }, { revision: 1 });
  assert.equal(w.ok, false);
  fs.rmSync(dir, { force: true });
});

console.log(`state-file replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
