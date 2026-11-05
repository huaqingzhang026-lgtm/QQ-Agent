// 稳定事件封装（S1.1）：所有"决定/忽略/发送/失败"走同一条结构化出口。
//
// 设计约束（来自改造方案）：
//   · 复用现有 logger，不另起一套并行日志系统；
//   · 默认不记录正文、认证头、工具敏感参数；
//   · 通过环境变量 QQ_TRACE=1 开启（写 state/trace.jsonl），默认关闭，
//     这样在用户确认上线之前不改变生产磁盘行为；
//   · 写失败绝不影响主流程。

import fs from 'node:fs';
import path from 'node:path';

const ENABLED = String(process.env.QQ_TRACE ?? '') === '1';
const FILE = process.env.QQ_TRACE_FILE || '';

let fd = null;
let writeFailures = 0;

function openFile() {
  if (fd !== null || !FILE) return fd;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fd = fs.openSync(FILE, 'a');
  } catch {
    fd = null;
  }
  return fd;
}

/**
 * 记录一条结构化事件。
 * 只允许标量/数组/短对象；超长字段截断，防止把整段聊天写进日志。
 */
export function emitEvent(event) {
  if (!ENABLED) return;
  const safe = { ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(event ?? {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') safe[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    else if (Array.isArray(v)) safe[k] = v.slice(0, 20).map((x) => (typeof x === 'object' ? '[obj]' : String(x).slice(0, 80)));
    else if (typeof v === 'object') safe[k] = '[obj]';
  }
  try {
    const line = `${JSON.stringify(safe)}\n`;
    const target = openFile();
    if (target === null) return;
    fs.writeSync(target, line);
  } catch {
    writeFailures += 1;
  }
}

/** 供 health/诊断读取：结构化日志是否开启、写入失败次数。 */
export function traceStatus() {
  return { enabled: ENABLED, file: FILE || null, writeFailures };
}

export default { emitEvent, traceStatus };
