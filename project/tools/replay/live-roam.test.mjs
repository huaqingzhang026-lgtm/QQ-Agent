// 回放：巡游选房与每日预算。
import assert from 'node:assert/strict';
import { pickCandidates, budgetState, shouldRotate, inActiveHours, todayKey } from '../../qq-bridge/src/live-roam-lib.js';

let pass = 0;
const fails = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const ls = [
  { roomid: 1, uid: '10', uname: '大主播', online: 50000 },
  { roomid: 2, uid: '20', uname: '小主播A', online: 30 },
  { roomid: 3, uid: '30', uname: '小主播B', online: 120 },
  { roomid: 4, uid: '40', uname: '示例主播', online: 20 },
  { roomid: 5, uid: '50', uname: '太小', online: 1 },
];

check('只留人气低且排除自己人', () => {
  const c = pickCandidates(ls, { maxViewers: 100, minViewers: 5, excludeUids: ['40'], excludeRooms: ['999'] });
  assert.deepEqual(c.map((x) => x.roomid), [2]);
});

check('maxViewers 放宽后包含 120', () => {
  const c = pickCandidates(ls, { maxViewers: 200, excludeUids: ['40'] });
  assert.deepEqual(c.map((x) => x.roomid), [2, 3]);
});

check('预算：当天用满 → exhausted', () => {
  const now = Date.now();
  const b = budgetState({ date: todayKey(now), usedSeconds: 180 * 60 }, { dailyMinutes: 180, now });
  assert.equal(b.exhausted, true);
  assert.equal(b.remainSeconds, 0);
});

check('预算：跨天重置', () => {
  const now = Date.now();
  const b = budgetState({ date: '2000-01-01', usedSeconds: 180 * 60 }, { dailyMinutes: 180, now });
  assert.equal(b.usedSeconds, 0);
  assert.equal(b.exhausted, false);
});

check('换台：下播立即换', () => {
  assert.equal(shouldRotate({ session: { roomId: 1, startedAt: Date.now() }, roomLive: false }), true);
});

check('换台：到 20 分钟换', () => {
  const now = Date.now();
  assert.equal(shouldRotate({ session: { roomId: 1, startedAt: now - 20 * 60000 - 1 }, now, sessionMinutes: 20, roomLive: true }), true);
  assert.equal(shouldRotate({ session: { roomId: 1, startedAt: now - 5 * 60000 }, now, sessionMinutes: 20, roomLive: true }), false);
});

check('活动时间：10-24', () => {
  const at = (h) => new Date(2026, 9, 23, h, 0, 0).getTime();
  assert.equal(inActiveHours(at(11), { start: 10, end: 24 }), true);
  assert.equal(inActiveHours(at(9), { start: 10, end: 24 }), false);
  assert.equal(inActiveHours(at(23), { start: 10, end: 24 }), true);
});

console.log(`live-roam replay: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗', f); process.exit(1); }
console.log('全部通过');
