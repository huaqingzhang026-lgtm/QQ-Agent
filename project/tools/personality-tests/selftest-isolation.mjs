// A00-rework1 隔离自检（B02 实际子进程验证）。
//
// 与旧版区别：不再只验证 mock 对象，而是用真实 node 子进程 + isolation/preload.mjs
// 证明：越界写/未登记网络在副作用前被阻断；合法写入/登记 fixture/自监听 loopback 可用；
// 缺失策略时拒绝运行；node 孙进程递归继承；stdout/stderr 不被误拦。
//
// 用法：node tools/personality-tests/selftest-isolation.mjs
// 退出码：0 全部通过；1 失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createMockTransport, createFetchSentinel } from './mocks/transport.mjs';
import { createTempDataRoot, snapshotTree, diffSnapshots } from './mocks/data-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_ROOT = path.resolve(HERE, '..', '..');
const PRELOAD = path.join(HERE, 'isolation', 'preload.mjs');
const PRELOAD_URL = pathToFileURL(PRELOAD).href;
const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail ?? null });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const STATE_DIR = path.join(CANDIDATE_ROOT, 'qq-bridge', 'state');
const AGENT_HOME = path.join(CANDIDATE_ROOT, 'agent-home');
const beforeProtected = { state: snapshotTree(STATE_DIR), agentHome: snapshotTree(AGENT_HOME) };

// 自检根目录：在 runner 下必须落在 TEMP=dataRoot/tmp；独立运行时用系统临时目录。
const base = process.env.A00_DATA_ROOT
  ? path.join(process.env.A00_DATA_ROOT, 'tmp')
  : os.tmpdir();
const selftestRoot = fs.mkdtempSync(path.join(base, 'a00-selftest-'));
const allowedDir = path.join(selftestRoot, 'allowed');
const tempDir = path.join(selftestRoot, 'tmp');
const outsideDir = path.join(selftestRoot, 'outside');
const underRunner = Boolean(process.env.A00_ISOLATION_POLICY);
let runnerPolicy = null;
if (underRunner) {
  try { runnerPolicy = JSON.parse(fs.readFileSync(process.env.A00_ISOLATION_POLICY, 'utf8').replace(/^\uFEFF/, '')); } catch { runnerPolicy = null; }
}
const runnerViolationsFile = runnerPolicy?.violationsFile ?? null;
const scriptsDir = path.join(selftestRoot, 'scripts');
const policyDir = path.join(selftestRoot, 'policy');
for (const dir of [allowedDir, tempDir, outsideDir, scriptsDir, policyDir]) fs.mkdirSync(dir, { recursive: true });

const writeScript = (name, source) => {
  const file = path.join(scriptsDir, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
};
const sha256 = (file) => fs.readFileSync(file).length; // 仅用于记录，不需要真哈希

let policyCounter = 0;
function makePolicy({ writeRoots, allowEndpoints = [], protectedRoots = [] } = {}) {
  policyCounter += 1;
  const file = path.join(policyDir, `policy-${policyCounter}.json`);
  const violationsFile = path.join(policyDir, `violations-${policyCounter}.jsonl`);
  const selfPortsFile = path.join(policyDir, 'self-ports.jsonl');
  fs.writeFileSync(violationsFile, '', 'utf8');
  const policy = {
    schemaVersion: 1,
    version: 'selftest',
    generatedAt: new Date().toISOString(),
    runnerPid: process.pid,
    dataRoot: selftestRoot,
    reportDir: allowedDir,
    writeRoots: writeRoots ?? [allowedDir, tempDir],
    denyWritePaths: [policyDir, violationsFile, selfPortsFile],
    protectedRoots,
    allowEndpoints,
    violationsFile,
    selfPortsFile,
  };
  fs.writeFileSync(file, JSON.stringify(policy, null, 2), 'utf8');
  return { file, violationsFile, selfPortsFile };
}

function readViolations(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return { parseError: l }; }
    });
  } catch { return []; }
}

const runChild = (script, args = [], env = {}) => new Promise((resolve) => {
  const childEnv = {
    ...process.env,
    A00_ISOLATION_POLICY: env.policyFile,
    A00_ISOLATION_DEBUG: '',
    TEMP: env.TEMP ?? tempDir,
    TMP: env.TEMP ?? tempDir,
    TMPDIR: env.TEMP ?? tempDir,
    NODE_OPTIONS: `--import "${PRELOAD_URL}"`,
    ...execEnvOverrides(env),
  };
  delete childEnv.A00_ISOLATION_DEBUG;
  if (env.clearPolicy) delete childEnv.A00_ISOLATION_POLICY;
  const child = spawn(process.execPath, ['--import', PRELOAD_URL, script, ...args], {
    cwd: selftestRoot, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 15000);
  child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error: String(error.message ?? error) }); });
  child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
});

function execEnvOverrides(env) {
  const out = {};
  if (env.env) Object.assign(out, env.env);
  return out;
}

// ── 1. mock 层保持不发送（旧自检语义保留） ──────────────────────────────────
check('mock transport 只捕获、不调用真实 fetch', () => {
  const sentinel = createFetchSentinel();
  const transport = createMockTransport();
  const results = [1, 2, 3].map((i) => transport.postOneBot({
    conversationKey: 'group:mock', action: 'send_group_msg', params: { group_id: 1, message: [{ type: 'text', data: { text: `m${i}` } }] }, fetchImpl: sentinel.fetchImpl,
  }));
  assert(transport.capturedCount === 3, `捕获数异常：${transport.capturedCount}`);
  assert(results.every((r) => r.ok === true && r.captured === true), 'mock 返回值异常');
  assert(sentinel.count === 0, `真实 fetch 哨兵被调用 ${sentinel.count} 次`);
  return { captured: transport.capturedCount, sentinelCalls: sentinel.count };
});

// ── 2. 子进程真实 I/O 边界 ─────────────────────────────────────────────────
const childScripts = {};

// 被 runner 执行时：C03 会强制父策略，测试不能再给子进程下发更窄的自定义策略；
// 因此改用 runner 策略边界做一组等价的写/链接/子进程/网络检查。完整自定义策略矩阵由
// standalone 模式覆盖（同一文件、同一 preload，不跳过隐藏问题，只改变可用的策略输入）。
async function runRunnerModeChecks() {
  const violationsSince = (n) => readViolations(runnerViolationsFile).slice(n);
  const violationCount = () => readViolations(runnerViolationsFile).length;
  const protectedFile = path.join(STATE_DIR, 'selftest-runner-mode.json');
  const sourceFile = path.join(CANDIDATE_ROOT, 'qq-bridge', 'src', 'bridge.js');
  const policyArg = process.env.A00_ISOLATION_POLICY;

  // 允许写 TEMP
  {
    const okFile = path.join(tempDir, 'runner-mode-ok.txt');
    const script = writeScript('runner-mode-allow.mjs', "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'ok');\n");
    const result = await runChild(script, [okFile], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：允许 TEMP 写入（正例）', () => {
      assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      assert(fs.existsSync(okFile), '合法 TEMP 文件未写出');
      return { exitCode: result.code };
    });
  }

  // 写 protected root（candidate qq-bridge/state）
  {
    const script = writeScript('runner-mode-protected.mjs', "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'x');\n");
    const before = violationCount();
    const result = await runChild(script, [protectedFile], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：protected root 写入被拒绝', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(protectedFile), 'protected 文件被写出');
      assert(violationsSince(before).some((v) => v.kind === 'write'), '未记录 write 违规');
      return { exitCode: result.code };
    });
  }

  // 硬链接：从 candidate 源码/写根外链接进 TEMP
  {
    const alias = path.join(tempDir, 'runner-mode-hardlink.txt');
    const script = writeScript('runner-mode-hardlink.mjs', "import fs from 'node:fs';\nfs.linkSync(process.argv[2], process.argv[3]);\n");
    const before = violationCount();
    const result = await runChild(script, [sourceFile, alias], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：写根外来源硬链接被拒绝（C01）', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(alias), '越界硬链接被创建');
      assert(violationsSince(before).some((v) => String(v.reason).startsWith('hardlink-source')), '未记录 hardlink-source 违规');
      return { exitCode: result.code };
    });
  }

  // 预置多链接别名：父进程在 TEMP 内建立 nlink=2 别名，子进程写它
  {
    const unique = path.join(tempDir, 'runner-mode-preset-unique.txt');
    const alias = path.join(tempDir, 'runner-mode-preset-alias.txt');
    fs.writeFileSync(unique, 'original', 'utf8');
    fs.linkSync(unique, alias);
    const script = writeScript('runner-mode-preset-alias.mjs', "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'changed via preset alias');\n");
    const before = violationCount();
    const result = await runChild(script, [alias], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：预置多链接别名写入被拒绝（C01）', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(fs.readFileSync(unique, 'utf8') === 'original', '预置别名目标被改写');
      assert(violationsSince(before).some((v) => String(v.reason).includes('multiple-hardlinks')), '未记录 nlink 违规');
      return { exitCode: result.code };
    });
  }

  // Node 孙进程 env={} 写 protected
  {
    const script = writeScript('runner-mode-node-child.mjs', [
      "import { spawnSync } from 'node:child_process';",
      "const code = \"require('node:fs').writeFileSync(process.argv[1], 'x')\";",
      "const r = spawnSync(process.execPath, ['-e', code, process.argv[2]], { env: {}, windowsHide: true, encoding: 'utf8' });",
      "if (r.status !== 0) throw new Error(String(r.stderr));",
    ].join('\n'));
    const before = violationCount();
    const result = await runChild(script, [protectedFile], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：Node 孙进程 env={} 仍被注入（C03）', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(protectedFile), '孙进程改写了 protected 文件');
      assert(violationsSince(before).some((v) => v.kind === 'write'), '未记录孙进程 write 违规');
      return { exitCode: result.code };
    });
  }

  // 合法 Node 孙进程 env={} 写 TEMP
  {
    const childOut = path.join(tempDir, 'runner-mode-child-ok.txt');
    const script = writeScript('runner-mode-node-legit.mjs', [
      "import fs from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "const code = \"require('node:fs').writeFileSync(process.argv[1], 'ok')\";",
      "const r = spawnSync(process.execPath, ['-e', code, process.argv[2]], { env: {}, windowsHide: true, encoding: 'utf8' });",
      "if (r.status !== 0) throw new Error(String(r.stderr));",
      "console.log('CHILD_OK', fs.existsSync(process.argv[2]));",
    ].join('\n'));
    const result = await runChild(script, [childOut], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：合法 Node 孙进程 env={} 可写 TEMP（正例）', () => {
      assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      assert(fs.existsSync(childOut), '合法孙进程未写出 TEMP 文件');
      return { exitCode: result.code };
    });
  }

  // 非 Node 子进程拒绝
  {
    const script = writeScript('runner-mode-non-node.mjs', [
      "import { spawnSync } from 'node:child_process';",
      "spawnSync('cmd.exe', ['/c', 'echo', 'x'], { env: {}, windowsHide: true, encoding: 'utf8' });",
      "console.log('NONNODE_RAN');",
    ].join('\n'));
    const before = violationCount();
    const result = await runChild(script, [], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：非 Node 子进程执行前拒绝（C03）', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!result.stdout.includes('NONNODE_RAN'), '非 Node 命令被执行');
      assert(violationsSince(before).some((v) => v.kind === 'process' && String(v.reason).includes('non-node')), '未记录 process 违规');
      return { exitCode: result.code };
    });
  }

  // worker eval 写 protected
  {
    const script = writeScript('runner-mode-worker.mjs', [
      "import { Worker } from 'node:worker_threads';",
      "const code = \"const { workerData } = require('node:worker_threads'); require('node:fs').writeFileSync(workerData, 'x')\";",
      "const worker = new Worker(code, { eval: true, workerData: process.argv[2] });",
      "worker.on('error', () => process.exit(1));",
      "worker.on('exit', () => process.exit(1));",
      "setTimeout(() => process.exit(1), 5000);",
    ].join('\n'));
    const before = violationCount();
    const result = await runChild(script, [protectedFile], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：worker_threads 越界写被阻断（C03）', () => {
      assert(!fs.existsSync(protectedFile), 'worker 改写了 protected 文件');
      assert(violationsSince(before).some((v) => v.kind === 'write'), '未记录 worker write 违规');
      return { exitCode: result.code };
    });
  }

  // 未登记网络（127.0.0.1:1 不可达且未登记）
  {
    const script = writeScript('runner-mode-fetch.mjs', "await fetch('http://127.0.0.1:1/unregistered');\n");
    const before = violationCount();
    const result = await runChild(script, [], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：未登记网络目标在发出前拒绝', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(violationsSince(before).some((v) => v.kind === 'network'), '未记录 network 违规');
      return { exitCode: result.code };
    });
  }

  // 自监听 loopback
  {
    const script = writeScript('runner-mode-self-listen.mjs', [
      "import http from 'node:http';",
      "const server = http.createServer((req, res) => res.end('own'));",
      "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
      "const { port } = server.address();",
      "const r = await fetch('http://127.0.0.1:' + port + '/own');",
      "console.log('SELF_OK', await r.text());",
      "server.close();",
    ].join('\n'));
    const result = await runChild(script, [], { policyFile: policyArg, TEMP: tempDir });
    check('runner 模式：自监听 loopback 仍可访问（正例）', () => {
      assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      assert(result.stdout.includes('SELF_OK own'), '自监听访问未成功');
      return { exitCode: result.code };
    });
  }

  check('runner 模式：standalone-only 完整自定义策略矩阵', () => ({
    note: '硬链接来源/预置别名/C02 junction/自定义 writeRoots 等自定义策略用例由 standalone selftest 覆盖；runner 模式下 C03 不允许子进程选择更窄策略，故复验改用 runner 策略边界的等价检查。',
  }));
}

const runAsync = async () => {
  if (underRunner) { await runRunnerModeChecks(); return; }
  // 2.1 允许写：writeRoots 内 与 TEMP
  childScripts.writeInside = writeScript('write-inside.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const [allowed, temp] = process.argv.slice(2);
fs.writeFileSync(path.join(allowed, 'sync.txt'), 'ok');
await fs.promises.writeFile(path.join(temp, 'promise.txt'), 'ok');
fs.createWriteStream(path.join(allowed, 'stream.txt')).end('ok', () => {
  process.stdout.write('WROTE ' + allowed + ' TEMP=' + temp + '\\n');
});
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.writeInside, [allowedDir, tempDir], { policyFile: policy.file });
    const violations = readViolations(policy.violationsFile);
    check('允许：writeRoots/TEMP 内写入成功且无违规', () => {
      assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      assert(fs.existsSync(path.join(allowedDir, 'sync.txt')), 'sync.txt 未写出');
      assert(fs.existsSync(path.join(tempDir, 'promise.txt')), 'promise.txt 未写出');
      assert(violations.length === 0, `出现违规 ${violations.length} 条`);
      return { exitCode: result.code };
    });
  }

  // 2.2 同步越界写：副作用前阻断
  childScripts.writeOutsideSync = writeScript('write-outside-sync.mjs', `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.argv[2], 'forbidden-sync.txt'), 'x');
console.log('SHOULD_NOT_REACH');
`);
  {
    const policy = makePolicy();
    const target = path.join(outsideDir, 'forbidden-sync.txt');
    const result = await runChild(childScripts.writeOutsideSync, [outsideDir], { policyFile: policy.file });
    const violations = readViolations(policy.violationsFile);
    check('同步越界写在系统调用前阻断（文件不存在 + 违规记录）', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(target), '越界文件被写出');
      assert(violations.some((v) => v.kind === 'write'), '未记录 write 违规');
      assert(!result.stdout.includes('SHOULD_NOT_REACH'), '违规后仍执行到后续代码');
      return { exitCode: result.code, violations: violations.length };
    });
  }

  // 2.3 async / promise / stream / open(w) / mkdir / rm / rename 覆盖
  childScripts.writeOutsideAsync = writeScript('write-outside-async.mjs', `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
const out = process.argv[2];
await fsp.writeFile(path.join(out, 'p.txt'), 'x');
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.writeOutsideAsync, [outsideDir], { policyFile: policy.file });
    check('fs.promises 越界写被拒绝', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(path.join(outsideDir, 'p.txt')), '越界文件被写出');
      assert(readViolations(policy.violationsFile).some((v) => v.kind === 'write'), '未记录 write 违规');
      return { exitCode: result.code };
    });
  }
  childScripts.writeOutsideCallback = writeScript('write-outside-cb.mjs', `
import fs from 'node:fs';
import path from 'node:path';
fs.appendFile(path.join(process.argv[2], 'cb.txt'), 'x', () => { console.log('CB_RETURNED'); });
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.writeOutsideCallback, [outsideDir], { policyFile: policy.file });
    check('回调式越界写被拒绝（无副作用）', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(path.join(outsideDir, 'cb.txt')), '越界文件被写出');
      assert(readViolations(policy.violationsFile).some((v) => v.kind === 'write'), '未记录 write 违规');
      return { exitCode: result.code };
    });
  }
  childScripts.writeOutsideStream = writeScript('write-outside-stream.mjs', `
import fs from 'node:fs';
import path from 'node:path';
fs.createWriteStream(path.join(process.argv[2], 'stream.txt')).end('x');
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.writeOutsideStream, [outsideDir], { policyFile: policy.file });
    check('createWriteStream 越界被拒绝', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(path.join(outsideDir, 'stream.txt')), '越界文件被写出');
      assert(readViolations(policy.violationsFile).some((v) => v.kind === 'write' && String(v.api).includes('createWriteStream')), '未记录 stream 违规');
      return { exitCode: result.code };
    });
  }
  childScripts.writeOutsideOpen = writeScript('write-outside-open.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const fd = fs.openSync(path.join(process.argv[2], 'open.txt'), 'w');
fs.writeSync(fd, 'x');
fs.closeSync(fd);
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.writeOutsideOpen, [outsideDir], { policyFile: policy.file });
    check('open(w 标志) 越界被拒绝', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(path.join(outsideDir, 'open.txt')), '越界文件被写出');
      assert(readViolations(policy.violationsFile).some((v) => v.kind === 'write' && String(v.api).includes('open')), '未记录 open 违规');
      return { exitCode: result.code };
    });
  }
  childScripts.mutate = writeScript('mutate-outside.mjs', `
import fs from 'node:fs';
const [op, target] = process.argv.slice(2);
if (op === 'mkdir') fs.mkdirSync(target, { recursive: true });
else if (op === 'rm') fs.rmSync(target, { force: true });
else if (op === 'rename') fs.renameSync(target, target + '.moved');
else if (op === 'chmod') fs.chmodSync(target, 0o444);
else throw new Error('unknown op');
console.log('MUTATE_DONE');
`);
  {
    const ops = [
      { op: 'mkdir', args: [path.join(outsideDir, 'newdir')], assertGone: () => !fs.existsSync(path.join(outsideDir, 'newdir')) },
      { op: 'rm', args: [path.join(outsideDir, 'victim.txt')], assertGone: () => fs.existsSync(path.join(outsideDir, 'victim.txt')) },
      { op: 'rename', args: [path.join(outsideDir, 'victim.txt')], assertGone: () => fs.existsSync(path.join(outsideDir, 'victim.txt')) && !fs.existsSync(path.join(outsideDir, 'victim.txt.moved')) },
      { op: 'chmod', args: [path.join(outsideDir, 'victim.txt')], assertGone: () => fs.existsSync(path.join(outsideDir, 'victim.txt')) },
    ];
    check('mkdir/rm/rename/chmod 越界均被逐一拒绝且 victim 保持', () => {
      const details = [];
      for (const { op, args, assertGone } of ops) {
        fs.writeFileSync(path.join(outsideDir, 'victim.txt'), 'keep-me', 'utf8');
        const policy = makePolicy({ writeRoots: [allowedDir, tempDir] });
        // 同步等待子进程（本自检在主线程用 async 不方便逐项断言）
        const childEnv = {
          ...process.env,
          A00_ISOLATION_POLICY: policy.file,
          TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir,
          NODE_OPTIONS: `--import "${PRELOAD_URL}"`,
        };
        delete childEnv.A00_ISOLATION_DEBUG;
        const result = spawnSync(process.execPath, ['--import', PRELOAD_URL, childScripts.mutate, op, ...args], {
          cwd: selftestRoot, env: childEnv, windowsHide: true, encoding: 'utf8',
        });
        assert(result.status !== 0, `${op} 预期非零退出，实际 ${result.status}`);
        assert(assertGone(), `${op} 产生了越界副作用`);
        const violations = readViolations(policy.violationsFile);
        assert(violations.some((v) => v.kind === 'write'), `${op} 未记录 write 违规`);
        details.push({ op, exitCode: result.status, violations: violations.length });
      }
      return { details };
    });
  }

  // 2.4 网络：未登记目标请求不得到达
  let unregisteredRequests = 0;
  const unregisteredServer = http.createServer((req, res) => { unregisteredRequests += 1; res.end('unregistered'); });
  await new Promise((resolve) => unregisteredServer.listen(0, '127.0.0.1', resolve));
  const unregisteredPort = unregisteredServer.address().port;
  try {
    childScripts.fetchUnregistered = writeScript('fetch-unregistered.mjs', `
const url = process.argv[2];
const response = await fetch(url);
if (response.ok) console.log('FETCH_OK');
`);
    {
      const policy = makePolicy();
      const result = await runChild(childScripts.fetchUnregistered, [`http://127.0.0.1:${unregisteredPort}/synthetic`], { policyFile: policy.file });
      check('未登记 HTTP 目标：请求未到达 + 子进程失败', () => {
        assert(unregisteredRequests === 0, `未登记服务收到 ${unregisteredRequests} 次请求`);
        assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
        assert(readViolations(policy.violationsFile).some((v) => v.kind === 'network'), '未记录 network 违规');
        return { requests: unregisteredRequests, exitCode: result.code };
      });
    }
    // 登记后可用
    childScripts.fetchRegistered = writeScript('fetch-registered.mjs', `
const response = await fetch(process.argv[2]);
const text = await response.text();
console.log('FETCH_OK ' + text);
`);
    {
      const policy = makePolicy({ allowEndpoints: [{ host: '127.0.0.1', port: unregisteredPort }] });
      const result = await runChild(childScripts.fetchRegistered, [`http://127.0.0.1:${unregisteredPort}/synthetic`], { policyFile: policy.file });
      check('--allow-endpoint 登记后 fixture 可正常访问', () => {
        assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 300)}`);
        assert(unregisteredRequests >= 1, '登记 fixture 未收到请求');
        assert(result.stdout.includes('FETCH_OK'), '未收到响应内容');
        return { requests: unregisteredRequests };
      });
    }
    // http.request 同样受控
    childScripts.httpRequestUnregistered = writeScript('http-unregistered.mjs', `
import http from 'node:http';
const [, , host, port] = process.argv;
const req = http.request({ host, port: Number(port), path: '/synthetic' }, (res) => { console.log('HTTP_OK'); res.resume(); });
req.end();
`);
    {
      const policy = makePolicy();
      const beforeCount = unregisteredRequests;
      const result = await runChild(childScripts.httpRequestUnregistered, ['127.0.0.1', String(unregisteredPort)], { policyFile: policy.file });
      check('node:http.request 未登记目标被拒绝，请求未到达', () => {
        assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
        assert(unregisteredRequests === beforeCount, `未登记服务收到 ${unregisteredRequests - beforeCount} 次请求`);
        return { exitCode: result.code };
      });
    }
  } finally {
    unregisteredServer.closeAllConnections?.();
    await new Promise((resolve) => unregisteredServer.close(resolve));
  }

  // 2.5 自监听 loopback 端口（共享注册表）
  childScripts.selfPort = writeScript('self-port.mjs', `
import http from 'node:http';
const server = http.createServer((req, res) => res.end('own'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const response = await fetch('http://127.0.0.1:' + port + '/own');
const text = await response.text();
server.close();
if (text !== 'own') process.exit(3);
console.log('SELF_PORT_OK ' + port);
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.selfPort, [], { policyFile: policy.file });
    check('子进程自监听 loopback 端口可被自己访问（self-ports 注册表）', () => {
      assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 400)}`);
      assert(result.stdout.includes('SELF_PORT_OK'), '自监听访问未成功');
      const registry = fs.readFileSync(policy.selfPortsFile, 'utf8').trim();
      assert(registry.length > 0, 'self-ports.jsonl 未记录端口');
      return { registryLines: registry.split(/\r?\n/).length };
    });
  }

  // 2.6 策略缺失 fail-closed
  childScripts.exit0 = writeScript('exit0.mjs', 'console.log("NO_POLICY_RAN");\n');
  {
    const result = await runChild(childScripts.exit0, [], { clearPolicy: true });
    check('缺少策略文件时拒绝运行（fail-closed）', () => {
      if (process.env.A00_ISOLATION_POLICY) {
        // 被 runner 执行时，本进程自身已在 preload 下；C03 会强制给孙进程注入策略，
        // 因此“缺少策略”只能由 standalone 模式覆盖。
        return { skippedUnderPreloadedParent: true, note: 'standalone 覆盖该检查；C03 强制策略后无法从孙进程模拟缺失' };
      }
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!result.stdout.includes('NO_POLICY_RAN'), '无策略时仍执行了主脚本');
      return { exitCode: result.code };
    });
  }

  // 2.7 递归注入：node 孙进程
  childScripts.grandchild = writeScript('grandchild-spawn.mjs', `
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const outside = process.argv[2];
const script = process.argv[3];
const result = spawnSync(process.execPath, [script, outside], { encoding: 'utf8' });
process.stdout.write('GRANDCHILD_CODE=' + result.status + '\\n');
`);
  childScripts.grandchildWrite = writeScript('grandchild-write.mjs', `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.argv[2], 'grandchild.txt'), 'x');
`);
  {
    const policy = makePolicy();
    const result = await runChild(childScripts.grandchild, [outsideDir, childScripts.grandchildWrite], { policyFile: policy.file });
    check('node 孙进程经 NODE_OPTIONS 递归注入，越界写同样被拒', () => {
      assert(result.code === 0, `父进程应正常退出：${result.code}`);
      assert(/GRANDCHILD_CODE=[1-9]/.test(result.stdout), `孙进程未失败：${result.stdout.slice(0, 200)}`);
      assert(!fs.existsSync(path.join(outsideDir, 'grandchild.txt')), '孙进程越界写成功');
      return { stdout: result.stdout.trim() };
    });
  }

  // 2.8 继承环境不绕过
  childScripts.envBypass = writeScript('env-bypass.mjs', `
import fs from 'node:fs';
const target = process.env.A00_TEST_FORBIDDEN_TARGET;
fs.writeFileSync(target, 'x');
`);
  {
    const policy = makePolicy();
    const target = path.join(outsideDir, 'env-bypass.txt');
    const result = await runChild(childScripts.envBypass, [], { policyFile: policy.file, env: { A00_TEST_FORBIDDEN_TARGET: target } });
    check('子进程继承 env 中的越界路径不绕过 preload', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(target), '环境变量指向的越界文件被写出');
      return { exitCode: result.code };
    });
  }

  // 2.9 protected root 写入被拒
  {
    const policy = makePolicy({ protectedRoots: [STATE_DIR] });
    childScripts.protectedWrite = writeScript('protected-write.mjs', `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.argv[2], 'selftest-should-not-write.json'), 'x');
`);
    const result = await runChild(childScripts.protectedWrite, [STATE_DIR], { policyFile: policy.file });
    check('protected root 写入被拒绝', () => {
      assert(result.code !== 0, `预期非零退出，实际 ${result.code}`);
      assert(!fs.existsSync(path.join(STATE_DIR, 'selftest-should-not-write.json')), 'protected root 被写入');
      assert(readViolations(policy.violationsFile).some((v) => v.kind === 'write'), '未记录 write 违规');
      return { exitCode: result.code };
    });
  }

  // 2.9b C01 硬链接（越界来源拒绝 / 预置别名拒绝 / 允许根内唯一来源正例）
  {
    const c01Target = path.join(outsideDir, 'c01-target.txt');
    fs.writeFileSync(c01Target, 'original', 'utf8');
    childScripts.c01LinkOutside = writeScript('c01-link-outside.mjs', `
import fs from 'node:fs';
import path from 'node:path';
fs.linkSync(process.argv[2], path.join(process.argv[3], 'c01-alias.txt'));
fs.writeFileSync(path.join(process.argv[3], 'c01-alias.txt'), 'changed');
`);
    const policyOutside = makePolicy();
    const rLinkOutside = await runChild(childScripts.c01LinkOutside, [c01Target, allowedDir], { policyFile: policyOutside.file });
    check('C01 从写根外建硬链接被拒绝且目标未改', () => {
      assert(rLinkOutside.code !== 0, `预期非零退出，实际 ${rLinkOutside.code}`);
      assert(!fs.existsSync(path.join(allowedDir, 'c01-alias.txt')), '越界硬链接被创建');
      assert(fs.readFileSync(c01Target, 'utf8') === 'original', '目标被改写');
      assert(readViolations(policyOutside.violationsFile).some((v) => v.kind === 'write' && String(v.reason).startsWith('hardlink-source')), '未记录 hardlink-source 违规');
      return { exitCode: rLinkOutside.code };
    });

    const c01PresetUnique = path.join(tempDir, 'c01-preset-unique.txt');
    const c01PresetAlias = path.join(tempDir, 'c01-preset-alias.txt');
    fs.writeFileSync(c01PresetUnique, 'original', 'utf8');
    fs.linkSync(c01PresetUnique, c01PresetAlias);
    childScripts.c01PresetWrite = writeScript('c01-preset-write.mjs', `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], 'changed via preset alias');
`);
    const policyPreset = makePolicy();
    const rPreset = await runChild(childScripts.c01PresetWrite, [c01PresetAlias], { policyFile: policyPreset.file });
    check('C01 预置多链接别名写入被拒绝且目标未改', () => {
      assert(rPreset.code !== 0, `预期非零退出，实际 ${rPreset.code}`);
      assert(fs.readFileSync(c01PresetUnique, 'utf8') === 'original', '预置别名目标被改写');
      assert(readViolations(policyPreset.violationsFile).some((v) => String(v.reason).includes('multiple-hardlinks')), '未记录 nlink 违规');
      return { exitCode: rPreset.code };
    });

    childScripts.c01Legit = writeScript('c01-legit-link.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const a = path.join(process.argv[2], 'c01-legit-unique.txt');
const b = path.join(process.argv[2], 'c01-legit-link.txt');
fs.writeFileSync(a, 'one');
fs.linkSync(a, b);
fs.writeFileSync(b, 'two');
console.log('C01_LEGIT_OK', fs.readFileSync(a, 'utf8'));
`);
    const policyLegit = makePolicy();
    const rLegit = await runChild(childScripts.c01Legit, [tempDir], { policyFile: policyLegit.file });
    check('C01 允许根内唯一来源的新链接可写（正例）', () => {
      assert(rLegit.code === 0, `exit=${rLegit.code} stderr=${rLegit.stderr.slice(0, 300)}`);
      assert(rLegit.stdout.includes('C01_LEGIT_OK two'), '链接写入未生效');
      assert(readViolations(policyLegit.violationsFile).length === 0, '正例出现违规');
      return { exitCode: rLegit.code };
    });
  }

  // 2.9c C02 顺序 junction（写前重新 realpath）+ 合法重命名
  {
    const c02Target = path.join(outsideDir, 'target.txt');
    fs.writeFileSync(c02Target, 'original', 'utf8');
    childScripts.c02Junction = writeScript('c02-junction.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const data = process.argv[2];
const forbidden = process.argv[3];
const dir = path.join(data, 'c02-route');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'target.txt'), 'warm cache');
fs.renameSync(dir, path.join(data, 'c02-old-route'));
fs.symlinkSync(forbidden, dir, 'junction');
fs.writeFileSync(path.join(dir, 'target.txt'), 'changed via junction');
`);
    const policyJunction = makePolicy();
    const rJunction = await runChild(childScripts.c02Junction, [tempDir, outsideDir], { policyFile: policyJunction.file });
    check('C02 rename+junction 后原路径写入被拒绝且目标未改', () => {
      assert(rJunction.code !== 0, `预期非零退出，实际 ${rJunction.code}`);
      assert(fs.readFileSync(c02Target, 'utf8') === 'original', 'junction 目标被改写');
      assert(readViolations(policyJunction.violationsFile).some((v) => v.kind === 'write' && String(v.reason).includes('outside-write-roots')), '未记录 realpath 越界违规');
      return { exitCode: rJunction.code };
    });

    childScripts.c02LegitRename = writeScript('c02-legit-rename.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const data = process.argv[2];
const dir = path.join(data, 'c02-legit-route');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'target.txt'), 'one');
fs.renameSync(dir, path.join(data, 'c02-legit-old'));
fs.writeFileSync(path.join(data, 'c02-legit-old', 'target.txt'), 'two');
console.log('C02_RENAME_OK');
`);
    const policyRename = makePolicy();
    const rRename = await runChild(childScripts.c02LegitRename, [tempDir], { policyFile: policyRename.file });
    check('C02 合法目录重命名后仍可写（正例）', () => {
      assert(rRename.code === 0, `exit=${rRename.code} stderr=${rRename.stderr.slice(0, 300)}`);
      assert(fs.readFileSync(path.join(tempDir, 'c02-legit-old', 'target.txt'), 'utf8') === 'two', '重命名后写入未生效');
      assert(readViolations(policyRename.violationsFile).length === 0, '正例出现违规');
      return { exitCode: rRename.code };
    });
  }

  // 2.9d C03 受控子进程 / worker
  {
    const c03Target = path.join(outsideDir, 'c03-target.txt');
    fs.writeFileSync(c03Target, 'original', 'utf8');
    childScripts.c03NodeEmptyEnv = writeScript('c03-node-empty-env.mjs', `
import { spawnSync } from 'node:child_process';
const code = "require('node:fs').writeFileSync(process.argv[1], 'changed via node child')";
const r = spawnSync(process.execPath, ['-e', code, process.argv[2]], { env: {}, windowsHide: true, encoding: 'utf8' });
if (r.status !== 0) throw new Error(String(r.stderr));
`);
    const policyNode = makePolicy();
    const rNode = await runChild(childScripts.c03NodeEmptyEnv, [c03Target], { policyFile: policyNode.file });
    check('C03 Node 孙进程 env={} 仍被注入隔离（目标未改）', () => {
      assert(rNode.code !== 0, `预期非零退出，实际 ${rNode.code}`);
      assert(fs.readFileSync(c03Target, 'utf8') === 'original', '目标被孙进程改写');
      assert(readViolations(policyNode.violationsFile).some((v) => v.kind === 'write'), '未记录孙进程 write 违规');
      return { exitCode: rNode.code };
    });

    childScripts.c03NodeLegit = writeScript('c03-node-legit.mjs', `
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const out = path.join(process.argv[2], 'c03-child-ok.txt');
const code = "require('node:fs').writeFileSync(process.argv[1], 'ok')";
const r = spawnSync(process.execPath, ['-e', code, out], { env: {}, windowsHide: true, encoding: 'utf8' });
if (r.status !== 0) throw new Error(String(r.stderr));
console.log('C03_CHILD_OK', fs.existsSync(out));
`);
    const policyNodeLegit = makePolicy();
    const rNodeLegit = await runChild(childScripts.c03NodeLegit, [tempDir], { policyFile: policyNodeLegit.file });
    check('C03 合法 Node 孙进程（env={}）仍可写 dataRoot（正例）', () => {
      assert(rNodeLegit.code === 0, `exit=${rNodeLegit.code} stderr=${rNodeLegit.stderr.slice(0, 300)}`);
      assert(rNodeLegit.stdout.includes('C03_CHILD_OK true'), '孙进程未成功写允许目录');
      return { exitCode: rNodeLegit.code };
    });

    childScripts.c03NonNode = writeScript('c03-non-node.mjs', `
import { spawnSync } from 'node:child_process';
spawnSync('cmd.exe', ['/c', 'echo', 'x'], { env: {}, windowsHide: true, encoding: 'utf8' });
console.log('NONNODE_RAN');
`);
    const policyNonNode = makePolicy();
    const rNonNode = await runChild(childScripts.c03NonNode, [], { policyFile: policyNonNode.file });
    check('C03 非 Node 子进程在执行前拒绝并记录 violation', () => {
      assert(rNonNode.code !== 0, `预期非零退出，实际 ${rNonNode.code}`);
      assert(!rNonNode.stdout.includes('NONNODE_RAN'), '非 Node 命令被执行');
      assert(readViolations(policyNonNode.violationsFile).some((v) => v.kind === 'process' && String(v.reason).includes('non-node')), '未记录 process 违规');
      return { exitCode: rNonNode.code };
    });

    const c03WorkerTarget = path.join(outsideDir, 'c03-worker-target.txt');
    fs.writeFileSync(c03WorkerTarget, 'original', 'utf8');
    childScripts.c03Worker = writeScript('c03-worker.mjs', `
import { Worker } from 'node:worker_threads';
const code = "const { workerData } = require('node:worker_threads'); require('node:fs').writeFileSync(workerData, 'changed via worker')";
const worker = new Worker(code, { eval: true, workerData: process.argv[2] });
worker.on('error', () => process.exit(1));
worker.on('exit', () => process.exit(1));
setTimeout(() => process.exit(1), 5000);
`);
    const policyWorker = makePolicy();
    const rWorker = await runChild(childScripts.c03Worker, [c03WorkerTarget], { policyFile: policyWorker.file });
    check('C03 worker_threads eval Worker 越界写被阻断', () => {
      assert(fs.readFileSync(c03WorkerTarget, 'utf8') === 'original', 'worker 改写了目标');
      assert(readViolations(policyWorker.violationsFile).some((v) => v.kind === 'write'), '未记录 worker write 违规');
      return { exitCode: rWorker.code };
    });
  }

  // 2.10 读不被误拦 + stdout/stderr 正常
  childScripts.readAndStdio = writeScript('read-stdio.mjs', `
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
console.log('READ_OK ' + text.trim());
process.stdout.write('STDOUT_OK\\n');
process.stderr.write('STDERR_OK\\n');
`);
  {
    const readMe = path.join(outsideDir, 'read-me.txt');
    fs.writeFileSync(readMe, 'readable', 'utf8');
    const policy = makePolicy();
    const result = await runChild(childScripts.readAndStdio, [readMe], { policyFile: policy.file });
    check('只读访问与 stdout/stderr 不被误拦', () => {
      assert(result.code === 0, `exit=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      assert(result.stdout.includes('READ_OK') && result.stdout.includes('STDOUT_OK'), 'stdout 内容缺失');
      assert(result.stderr.includes('STDERR_OK'), 'stderr 内容缺失');
      return { exitCode: result.code };
    });
  }
};

await runAsync();

// ── 3. 候选 state/agent-home 未被本自检写入 ───────────────────────────────
check('候选 qq-bridge/state 与 agent-home 未被写入', () => {
  const after = { state: snapshotTree(STATE_DIR), agentHome: snapshotTree(AGENT_HOME) };
  const diff = {
    state: diffSnapshots(beforeProtected.state, after.state),
    agentHome: diffSnapshots(beforeProtected.agentHome, after.agentHome),
  };
  assert(diff.state.length === 0 && diff.agentHome.length === 0, `候选状态被写入：${JSON.stringify(diff).slice(0, 400)}`);
  return { stateEntries: Object.keys(after.state).length, agentHomeEntries: Object.keys(after.agentHome).length };
});

try { fs.rmSync(selftestRoot, { recursive: true, force: true }); } catch { /* ignore */ }

const ok = checks.every((c) => c.ok);
console.log(`selftest-isolation: ${checks.filter((c) => c.ok).length}/${checks.length} 项通过`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.error}`);
const summary = {
  ok,
  runtime: process.version,
  node: process.execPath,
  candidateRoot: CANDIDATE_ROOT,
  underRunner: Boolean(process.env.A00_DATA_ROOT),
  selftestRoot,
  checks,
};
console.log('SELFTEST_RESULT ' + JSON.stringify(summary));
process.exit(ok ? 0 : 1);
