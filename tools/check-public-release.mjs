import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (list.status !== 0) throw new Error('Cannot enumerate the public Git repository');
const files = [...new Set(list.stdout.split('\0').filter(Boolean))];
const findings = [];
const forbidden = /(?:^|\/)(?:archive|work|migration|agent-home|node_modules|state|sessions|storages|backups|dsh-home|edge-profile[^/]*)(?:\/|$)|(?:^|\/)(?:config\.json|cookies?\.json|console-token|\.env(?:\..*)?|\.credentials\..*)$|\.(?:key|pem|p12|pfx|sqlite|db|log|zip)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['provider-api-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private-user-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!example(?:[\\/]|\b)|<)[A-Za-z0-9_.-]+/g],
  ['personal-account-id', /(?:ownerQQ|selfQQ|groupId|group_id|user_id|qq|roomId|room_id|uid)[^\n]{0,35}?\b([1-9]\d{6,11})\b/gi],
];
const syntheticIds = new Set(['12345678', '123456789', '1234567890', '987654321', '99999999', '1000000001']);
for (const file of files) {
  if (forbidden.test(file) && !/\.env\.(?:example|sample)$/.test(file)) findings.push({ file, rule: 'private-or-runtime-file' });
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep) || !fs.statSync(full).isFile()) continue;
  const data = fs.readFileSync(full);
  if (data.subarray(0, 8192).includes(0)) { findings.push({ file, rule: 'unreviewed-binary-file' }); continue; }
  const text = data.toString('utf8');
  for (const [rule, re] of rules) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (rule === 'personal-account-id' && syntheticIds.has(match[1])) continue;
      findings.push({ file, rule, line: text.slice(0, match.index).split('\n').length });
    }
  }
  const credential = /(?:access[_-]?token|auth[_-]?token|console[_-]?token|api[_-]?key|password|passwd|secret|sessdata|bili_jct)["']?\s*[:=]\s*["']([^"'\r\n]{10,})["']/gi;
  for (const match of text.matchAll(credential)) {
    const value = match[1];
    const sample = /test|fake|fixture|example|dummy|synthetic|placeholder|from-config|from-env|from-dsh|token|secret|[\u4e00-\u9fff]/i.test(value);
    const expression = /\$\{|\+\s*[A-Za-z_$]/.test(value);
    if (!sample && !expression) findings.push({ file, rule: 'credential-literal', line: text.slice(0, match.index).split('\n').length });
  }
}
console.log(JSON.stringify({ scannedFiles: files.length, findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
