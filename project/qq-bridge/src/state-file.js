// 状态文件读写（S4）：schemaVersion + revision + 外部修改检测 + 原子替换。
//
// 目标（state-ownership.md）：把"运行中直接改 JSON"的隐性冲突变成显式的：
//   · 每次保存 revision + 1；
//   · 保存前比对文件指纹（size+mtime），发现外部改动则**不覆盖**，返回 conflict；
//   · 写临时文件再 rename，避免半写；
//   · 失败时保留旧文件（不写空对象）。

import fs from 'node:fs';
import path from 'node:path';

export const STATE_SCHEMA_VERSION = 2;

export function fingerprint(file) {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

export function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;
}

/**
 * 读取状态文件；损坏时返回 null（调用方决定用默认值）。
 * @returns {{data: any, revision: number, schemaVersion: number, fp: object|null}|null}
 */
export function readStateFile(file) {
  const fp = fingerprint(file);
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(text);
    const revision = Number(data?.revision);
    const schemaVersion = Number(data?.schemaVersion);
    return {
      data,
      revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
      schemaVersion: Number.isFinite(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1,
      fp,
    };
  } catch {
    return null;
  }
}

/**
 * 原子保存：写临时文件 → rename；带 revision 与 schemaVersion。
 * @returns {{ok: boolean, conflict?: boolean, revision?: number, fp?: object}}
 */
export function writeStateFile(file, data, { expectedFp = null, revision = 0 } = {}) {
  const current = fingerprint(file);
  if (expectedFp && current && !sameFingerprint(current, expectedFp)) {
    return { ok: false, conflict: true };
  }
  const next = {
    ...data,
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: Number(revision) + 1,
  };
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, revision: next.revision, fp: fingerprint(file) };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 给任意 JSON 对象补默认字段（只补缺失的，不覆盖已有值）。
 */
export function withDefaults(data, defaults) {
  const out = { ...(data ?? {}) };
  for (const [k, v] of Object.entries(defaults ?? {})) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}
