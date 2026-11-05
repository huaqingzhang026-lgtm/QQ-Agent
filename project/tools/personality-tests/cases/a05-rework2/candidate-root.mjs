// A05-rework1：所有复制到候选内的验收测试都通过这里取得当前候选根。
// 禁止回到迁移前的旧候选根；所有测试只读取本 helper 解析出的当前候选。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CANDIDATE_ROOT = path.resolve(HERE, '../../../..');
export default CANDIDATE_ROOT;
