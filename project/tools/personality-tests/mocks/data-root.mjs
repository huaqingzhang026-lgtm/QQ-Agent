// 临时 dataRoot：所有测试写入都必须落在它下面，绝不写候选 state/agent-home，更不写 LIVE。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function createTempDataRoot(base = os.tmpdir(), prefix = 'personality-tests-') {
  const dataRoot = fs.mkdtempSync(path.join(base, prefix));
  ensureIsolatedLayout(dataRoot);
  return dataRoot;
}

export function ensureIsolatedLayout(dataRoot) {
  for (const sub of ['tmp', 'memory', 'home', 'state', 'agent-home']) {
    fs.mkdirSync(path.join(dataRoot, sub), { recursive: true });
  }
  return dataRoot;
}

export function assertContained(dataRoot, target, label = 'path') {
  const root = path.resolve(dataRoot);
  const abs = path.resolve(target);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} 越界：${abs} 不在临时 dataRoot ${root} 内`);
  }
  return abs;
}

export function writeIsolatedFile(dataRoot, relPath, content) {
  const abs = assertContained(dataRoot, path.join(dataRoot, relPath), 'write');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, typeof content === 'string' ? 'utf8' : undefined);
  return abs;
}

export function readIsolatedFile(dataRoot, relPath) {
  const abs = assertContained(dataRoot, path.join(dataRoot, relPath), 'read');
  return fs.readFileSync(abs, 'utf8');
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      out.set(rel + '/', { type: 'dir' });
      walk(abs, base, out);
    } else if (entry.isFile()) {
      const buf = fs.readFileSync(abs);
      out.set(rel, {
        type: 'file',
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      });
    }
  }
  return out;
}

export function snapshotTree(dir) {
  const out = new Map();
  if (fs.existsSync(dir)) walk(dir, dir, out);
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function diffSnapshots(before, after) {
  const changed = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) changed.push({ path: key, change: 'added', before: null, after: after[key] });
    else if (before[key].sha256 !== after[key].sha256 || before[key].size !== after[key].size) {
      changed.push({ path: key, change: 'modified', before: before[key], after: after[key] });
    }
  }
  for (const key of Object.keys(before)) if (!(key in after)) changed.push({ path: key, change: 'removed', before: before[key], after: null });
  return changed;
}
