// 回放：敷衍回复选择（annoyed-reply）。

import assert from 'node:assert/strict';
import { normalizeAnnoyedConfig, pickAnnoyedReply } from '../../qq-bridge/src/annoyed-reply.js';

const KEY = 'group:20002';
const cfg = {
  socialV2: {
    annoyedReply: {
      enabled: true,
      groups: {
        [KEY]: { probability: 0.3, minIntervalMs: 600000, lines: ['好烦', '不想回'] },
        'group:other': { probability: 0.5, lines: ['嗯'] },
      },
    },
  },
};

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

check('未配置的群禁用', () => {
  assert.equal(normalizeAnnoyedConfig(cfg, 'group:none'), null);
  assert.equal(pickAnnoyedReply({ cfg, key: 'group:none' }).send, false);
});

check('全局关闭', () => {
  assert.equal(normalizeAnnoyedConfig({ socialV2: { annoyedReply: { enabled: false, groups: { [KEY]: { probability: 1 } } } } }, KEY), null);
});

check('命中', () => {
  const r = pickAnnoyedReply({ cfg, key: KEY, random: () => 0.1 });
  assert.equal(r.send, true);
  assert.ok(['好烦', '不想回'].includes(r.line));
  assert.equal(r.reason, 'hit');
});

check('未命中', () => {
  const r = pickAnnoyedReply({ cfg, key: KEY, random: () => 0.9 });
  assert.equal(r.send, false);
  assert.equal(r.reason, 'miss');
});

check('冷却期不重复', () => {
  const now = 10_000_000;
  const r = pickAnnoyedReply({ cfg, key: KEY, now, lastAt: now - 1000, random: () => 0 });
  assert.equal(r.send, false);
  assert.equal(r.reason, 'cooldown');
});

check('冷却过了可以发', () => {
  const now = 10_000_000;
  const r = pickAnnoyedReply({ cfg, key: KEY, now, lastAt: now - 700000, random: () => 0 });
  assert.equal(r.send, true);
});

check('概率 0 不发', () => {
  const c = { socialV2: { annoyedReply: { groups: { [KEY]: { probability: 0, lines: ['x'] } } } } };
  assert.equal(pickAnnoyedReply({ cfg: c, key: KEY, random: () => 0 }).send, false);
});

check('空 lines 有兜底', () => {
  const c = { socialV2: { annoyedReply: { groups: { [KEY]: { probability: 1, lines: [] } } } } };
  const r = pickAnnoyedReply({ cfg: c, key: KEY, random: () => 0 });
  assert.equal(r.send, true);
  assert.ok(r.line.length > 0);
});

check('随机源决定选句', () => {
  const r1 = pickAnnoyedReply({ cfg, key: KEY, random: (() => { let i = 0; return () => (i++ === 0 ? 0.1 : 0); })() });
  const r2 = pickAnnoyedReply({ cfg, key: KEY, random: (() => { let i = 0; return () => (i++ === 0 ? 0.1 : 0.9); })() });
  assert.equal(r1.line, '好烦');
  assert.equal(r2.line, '不想回');
});

check('allGroups：没配 groups 也对所有群生效', () => {
  const cfg = { socialV2: { annoyedReply: { enabled: true, allGroups: true, probability: 0.1, lines: ['A', 'B'] } } };
  const r = pickAnnoyedReply({ cfg, key: 'group:999', random: () => 0.05 });
  assert.equal(r.send, true);
});

check('概率 10%：0.05 命中、0.5 不命中', () => {
  const cfg = { socialV2: { annoyedReply: { enabled: true, allGroups: true, probability: 0.1 } } };
  assert.equal(pickAnnoyedReply({ cfg, key: 'group:1', random: () => 0.05 }).send, true);
  assert.equal(pickAnnoyedReply({ cfg, key: 'group:1', random: () => 0.5 }).send, false);
});

check('不连续两次同一句', () => {
  const cfg = { socialV2: { annoyedReply: { enabled: true, allGroups: true, probability: 1, lines: ['X', 'Y'] } } };
  const r = pickAnnoyedReply({ cfg, key: 'group:1', lastLine: 'X', random: () => 0.04 });
  assert.equal(r.line, 'Y');
});

check('最小间隔内不敷衍', () => {
  const cfg = { socialV2: { annoyedReply: { enabled: true, allGroups: true, probability: 1, minIntervalMs: 60000 } } };
  const r = pickAnnoyedReply({ cfg, key: 'group:1', lastAt: Date.now() - 1000 });
  assert.equal(r.reason, 'cooldown');
});

console.log(`annoyed-reply replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
