import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-public-scan-'));
fs.mkdirSync(path.join(temp, 'tools'));
fs.copyFileSync(path.join(here, 'check-public-release.mjs'), path.join(temp, 'tools', 'check-public-release.mjs'));
const git = spawnSync('git', ['init', '--quiet'], { cwd: temp, windowsHide: true });
assert.equal(git.status, 0);
fs.writeFileSync(path.join(temp, 'README.md'), '# Synthetic release\n');
const scan = () => {
  const result = spawnSync(process.execPath, ['tools/check-public-release.mjs'], { cwd: temp, encoding: 'utf8', windowsHide: true });
  return { status: result.status, report: JSON.parse(result.stdout) };
};
assert.equal(scan().status, 0);
fs.writeFileSync(path.join(temp, 'leak.txt'), 'gh' + 'p_' + 'a'.repeat(36));
assert.ok(scan().report.findings.some((item) => item.rule === 'github-token'));
fs.writeFileSync(path.join(temp, 'leak.txt'), ['C:', 'Users', 'private-person', 'file.txt'].join(String.fromCharCode(92)));
assert.ok(scan().report.findings.some((item) => item.rule === 'private-user-path'));
fs.writeFileSync(path.join(temp, 'leak.txt'), 'owner' + 'QQ: ' + ['8765', '43210'].join(''));
assert.ok(scan().report.findings.some((item) => item.rule === 'personal-account-id'));
fs.writeFileSync(path.join(temp, '.env'), 'EMPTY=');
assert.ok(scan().report.findings.some((item) => item.rule === 'private-or-runtime-file'));
// Keep the synthetic temporary fixture; it contains no user data.
console.log('Public release scanner: positive and negative controls PASS');
