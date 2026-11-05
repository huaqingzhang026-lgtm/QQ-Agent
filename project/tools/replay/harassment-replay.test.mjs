// 回放：骚扰分模块（harassment）的确定性场景。
//
// 断言重点（behavior-spec §3）：
//   · 普通单条发言不加分；
//   · 正常 @ 本身不加分（caller 不再传 at 信号）；
//   · 连续追问且她还没回 → 加分；已经回过 → 不加；
//   · 辱骂 → 加 insultScore；
//   · 衰减只在读取时发生，重复读取不重复扣减；
//   · 到阈值触发冷落，返回分钟数。

import assert from 'node:assert/strict';
import {
  normalizeHarassmentConfig,
  shouldStaySilent,
  decayedScore,
  classifyMessage,
  decideMute,
  DEFAULT_HARASSMENT,
  isDirectedAtMe,
  applyMessage,
} from '../../qq-bridge/src/harassment.js';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass += 1; } catch (e) { failures.push(`${name}: ${e.message}`); }
};

// 1. 单条普通发言不加分
check('单条普通发言不加分', () => {
  assert.equal(classifyMessage({ windowCount: 1, repliedSince: false, text: '今天好热' }).added, 0);
});

// 2. 两条也不加（默认阈值 3）
check('两条不加分', () => {
  assert.equal(classifyMessage({ windowCount: 2, repliedSince: false, text: '在吗' }).added, 0);
});

// 3. 第三条且没回 → 加 1
check('连续三条未回 → +1', () => {
  const r = classifyMessage({ windowCount: 3, repliedSince: false, text: '在吗' });
  assert.equal(r.added, 1);
  assert.equal(r.reason, 'urge');
});

// 4. 已经回过 → 不加（正常追问不罚）
check('已回复后的追问不加分', () => {
  assert.equal(classifyMessage({ windowCount: 5, repliedSince: true, text: '那再问一句' }).added, 0);
});

// 5. 辱骂直接加分
check('辱骂 +3', () => {
  const r = classifyMessage({ windowCount: 1, repliedSince: true, text: '你个傻逼' });
  assert.equal(r.added, 3);
  assert.equal(r.reason, 'insult');
});

// 6. 辱骂优先于追问
check('辱骂优先', () => {
  assert.equal(classifyMessage({ windowCount: 9, repliedSince: false, text: '脑残' }).added, 3);
});

// 7. 空文本不误判
check('空文本不加分', () => {
  assert.equal(classifyMessage({ windowCount: 3, repliedSince: false, text: '' }).added, 0);
});

// 8. 配置覆盖阈值
check('urgeCount 覆盖为 2', () => {
  assert.equal(classifyMessage({ windowCount: 2, repliedSince: false, text: 'x', cfg: { urgeCount: 2 } }).added, 1);
});

// 9. 配置覆盖辱骂分
check('insultScore 覆盖为 5', () => {
  assert.equal(classifyMessage({ windowCount: 1, repliedSince: false, text: '废物', cfg: { insultScore: 5 } }).added, 5);
});

// 10. 衰减：5 分钟衰减 1.5
check('衰减 5 分钟', () => {
  const now = 10_000_000;
  assert.equal(decayedScore(5, now - 5 * 60000, now, 0.3), 3.5);
});

// 11. 衰减不会变负
check('衰减不为负', () => {
  assert.equal(decayedScore(1, 0, 999_999_999, 0.3), 0);
});

// 12. 重复读取同一时刻不重复扣减
check('读取幂等', () => {
  const now = 1_000_000;
  const a = decayedScore(4, now - 60000, now, 0.3);
  const b = decayedScore(4, now - 60000, now, 0.3);
  assert.equal(a, b);
});

// 13. 未来时间戳不产生负衰减（等价于不回血）
check('时钟回拨不回血', () => {
  assert.equal(decayedScore(2, Date.now() + 60000, Date.now(), 0.3), 2);
});

// 14. 阈值触发冷落
check('≥8 触发冷落', () => {
  const r = decideMute({ score: 8 });
  assert.equal(r.mute, true);
  assert.equal(r.minutes, 30);
});

// 15. 阈值以下不触发
check('7.9 不触发', () => {
  assert.equal(decideMute({ score: 7.9 }).mute, false);
});

// 16. 自定义阈值与时长
check('自定义阈值/时长', () => {
  const r = decideMute({ score: 5, cfg: { muteThreshold: 5, muteMinutes: 10 } });
  assert.equal(r.mute, true);
  assert.equal(r.minutes, 10);
});

// 17. 非法配置被夹住
check('非法配置归一', () => {
  const c = normalizeHarassmentConfig({ urgeCount: 0, muteThreshold: 99, decayPerMin: 'x' });
  assert.ok(c.urgeCount >= 2);
  assert.ok(c.muteThreshold <= 10);
  assert.equal(c.decayPerMin, DEFAULT_HARASSMENT.decayPerMin);
});

// 18. 关闭开关时不产生分数（由 caller 判断 enabled，这里校验默认值）
check('默认开关为开', () => {
  assert.equal(normalizeHarassmentConfig(undefined).enabled, true);
});

// ── 早退判定必须用衰减后的有效分（2026-10-23 修复）────────────────────────
check('16 小时前的 8 分 → 不再拦截', () => {
  const now = Date.now();
  const r = shouldStaySilent({ score: 8, at: now - 16 * 3600e3 }, now, {});
  assert.equal(r.skip, false);
  assert.equal(r.score, 0);
});

check('刚到的 8 分 → 拦截', () => {
  const now = Date.now();
  const r = shouldStaySilent({ score: 8, at: now }, now, {});
  assert.equal(r.skip, true);
});

check('5 分钟前的 8 分 → 衰减到 6.5，不拦', () => {
  const now = Date.now();
  const r = shouldStaySilent({ score: 8, at: now - 5 * 60000 }, now, {});
  assert.equal(r.score, 6.5);
  assert.equal(r.skip, false);
});

check('阈值可配置', () => {
  const now = Date.now();
  assert.equal(shouldStaySilent({ score: 5, at: now }, now, { muteThreshold: 5 }).skip, true);
  assert.equal(shouldStaySilent({ score: 5, at: now }, now, { muteThreshold: 6 }).skip, false);
});

check('空记录不算拦截', () => {
  assert.equal(shouldStaySilent(null, Date.now(), {}).skip, false);
});

check('未来时间戳不回血但也不误拦', () => {
  const now = Date.now();
  assert.equal(shouldStaySilent({ score: 8, at: now + 60000 }, now, {}).skip, true);
});

// F07：普通群聊不算"对她说"
check('@ 她 → 算', () => { assert.equal(isDirectedAtMe({ atSelf: true }), true); });
check('引用她的消息 → 算', () => { assert.equal(isDirectedAtMe({ quoteSelf: true }), true); });
check('文本里叫她名字 → 算', () => { assert.equal(isDirectedAtMe({ text: 'Pluto. 你在吗', selfNickname: 'Pluto.' }), true); });
check('普通群聊 → 不算', () => { assert.equal(isDirectedAtMe({ text: '今晚吃啥', selfNickname: 'Pluto.' }), false); });
check('没配置昵称时不因文本算', () => { assert.equal(isDirectedAtMe({ text: 'Pluto. 你好', selfNickname: '' }), false); });

// ── 整条计分路径（与桥接同一函数）─────────────────────────────────────────
check('10 条普通聊天 → 0 分、不冷落', () => {
  let rec = { score: 0, at: 0, window: [] };
  let now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    const r = applyMessage({ record: rec, window: rec.window, directedAtMe: false, repliedSince: true, text: '今晚吃啥', cfg: {}, now: now });
    rec = r.record;
    now += 1000;
  }
  assert.equal(rec.score, 0);
  assert.equal(decideMute({ score: rec.score }).mute, false);
});

check('连续 3 条 @ 且未回 → +1', () => {
  let rec = { score: 0, at: 0, window: [] };
  let now = 2_000_000;
  for (let i = 0; i < 3; i++) {
    const r = applyMessage({ record: rec, window: rec.window, directedAtMe: true, repliedSince: false, text: '在吗', cfg: {}, now });
    rec = r.record; now += 1000;
  }
  assert.equal(rec.score, 1);
});

check('已回复后的 @ 不累计', () => {
  let rec = { score: 0, at: 0, window: [] };
  const now = 3_000_000;
  for (let i = 0; i < 5; i++) {
    rec = applyMessage({ record: rec, window: rec.window, directedAtMe: true, repliedSince: true, text: '补充一下', cfg: {}, now }).record;
  }
  assert.equal(rec.score, 0);
});

check('辱骂 → +3（无论是否回）', () => {
  const now = 4_000_000;
  const r = applyMessage({ record: { score: 0, at: now }, window: [], directedAtMe: true, repliedSince: true, text: '你个傻逼', cfg: {}, now });
  assert.equal(r.added, 3);
});

check('普通聊天里的脏话不算（未对她说）', () => {
  const now = 5_000_000;
  const r = applyMessage({ record: { score: 0, at: now }, window: [], directedAtMe: false, repliedSince: true, text: '这游戏真垃圾', cfg: {}, now });
  assert.equal(r.added, 0);
});

console.log(`harassment replay: ${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('全部通过（18 项）');
