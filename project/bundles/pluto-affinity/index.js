// A04 好感度兼容适配器 · 原生 Host 插件
//
// 旧实现直接读写 qq-bridge/state/affinity.json 的 score，等于绕过了人格状态库。
// A04 起：
//   · affinity_get/list 只读 bridge 写出的关系投影（trust/closeness/tension/familiarity）；
//   · affinity_bump 不再直接改分数，只写候选请求；bridge 在本会话用真实消息证据复核后才写事件；
//   · 没有 evidenceIds / 没有 key 的调用只记“待核实”，不产生关系变化；
//   · affinity_set 停用直接设置；affinity_note 只记待核实笔记，不进入群聊可见上下文。
//
// 工具名前缀 mcp__affinity__ 保持不变，人格正文和 qq-tool-restrict 白名单仍按前缀匹配。
import fs from 'node:fs';
import path from 'node:path';
import {
  readProjection, describeRelationship, normalizeBumpRequest,
  enqueueBumpRequest, recordPendingObservation,
} from '../../qq-bridge/src/personality-affinity-adapter.mjs';

export const name = 'pluto-affinity';
export const inject = ['tools'];

/** DSH 由 run-dsh.cmd 以工作区为 cwd 启动；换机器/换 cwd 时按候选目录兜底。 */
function resolveWorkspace() {
  const candidates = [process.cwd(), path.resolve(process.cwd(), '..')];
  if (process.env.DSH_HOME) candidates.push(path.resolve(process.env.DSH_HOME, '..'));
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'qq-bridge', 'state')).isDirectory()) return dir;
    } catch {}
  }
  return process.cwd();
}

const root = () => resolveWorkspace();

export const HANDLERS = {
  async affinity_get({ uin }) {    return describeRelationship(readProjection(root()), String(uin ?? ''));
  },

  async affinity_bump({ uin, key, delta = 0, reason = '', evidenceIds = [] }) {
    const checked = normalizeBumpRequest({ uin, key, delta, reason, evidenceIds });
    if (!checked.ok) {
      recordPendingObservation(root(), {
        uin, key, delta, reason, evidenceIds,
        kind: checked.code === 'evidence-required' ? 'unverified-no-evidence' : 'unverified-invalid-request',
      });
      return `未改真实关系：${checked.code}。已记为待核实；需要本会话真实消息 evidenceIds 和会话 key 才能提交候选。`;
    }
    const queued = enqueueBumpRequest(root(), checked.request);
    return `已提交关系候选（队列 ${queued.count}），等待 bridge 用本会话证据复核；不会直接改 trust/closeness/tension。`;
  },

  async affinity_set() {
    recordPendingObservation(root(), { kind: 'rejected-direct-set' });
    return '已停用直接设置关系维度。请用 affinity_bump 并提供本会话 evidenceIds；否则只会记为待核实。';
  },

  async affinity_note({ uin, text }) {
    recordPendingObservation(root(), { uin, reason: text, kind: 'note' });
    return `已记下关于 ${uin} 的待核实笔记（不作为关系分，也不会进入群聊可见上下文）。`;
  },

  async affinity_list({ limit = 20 }) {
    const projection = readProjection(root());
    const rows = Object.entries(projection.people)
      .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
      .slice(0, Math.min(Number(limit) || 20, 100))
      .map(([uin, rel]) => `${uin}  ${rel.tier || '陌生人'}  信任 ${Math.round((Number(rel.trust) || 0) * 100)} / 亲近 ${Math.round((Number(rel.closeness) || 0) * 100)} / 紧张 ${Math.round((Number(rel.tension) || 0) * 100)}`);
    return rows.length ? `关系概况（只读，按更新时间）\n${rows.join('\n')}` : '还没有可用的关系记录。';
  },
};

const TOOLS = [
  {
    name: 'mcp__affinity__affinity_get',
    handler: 'affinity_get',
    write: false,
    description: '查某个 QQ 用户的长期关系维度（信任/亲近/紧张/熟悉）。只读，不返回私聊原文或笔记。',
    parameters: { type: 'object', properties: { uin: { type: 'string', description: '对方 QQ 号' } }, required: ['uin'] },
  },
  {
    name: 'mcp__affinity__affinity_bump',
    handler: 'affinity_bump',
    write: true,
    description: '提交一条关系观察候选；必须给出当前会话 key 和真实消息 evidenceIds。不会直接改关系维度，bridge 复核后才生效。不要每轮调用。',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string' },
        key: { type: 'string', description: '当前会话，如 private:123 / group:456' },
        delta: { type: 'number', description: '候选变化，建议 -0.03..0.03' },
        reason: { type: 'string', description: '一句话理由' },
        evidenceIds: { type: 'array', items: { type: 'string' }, description: '本轮真实消息 ID；缺失则只记待核实' },
      },
      required: ['uin', 'key', 'delta', 'evidenceIds'],
    },
  },
  {
    name: 'mcp__affinity__affinity_set',
    handler: 'affinity_set',
    write: true,
    description: '已停用：不能直接设置关系维度，只记录待核实。',
    parameters: { type: 'object', properties: { uin: { type: 'string' }, score: { type: 'number' }, note: { type: 'string' } }, required: ['uin', 'score'] },
  },
  {
    name: 'mcp__affinity__affinity_note',
    handler: 'affinity_note',
    write: true,
    description: '记一条待核实印象；不作为关系分，也不会进入群聊可见上下文。',
    parameters: { type: 'object', properties: { uin: { type: 'string' }, text: { type: 'string' } }, required: ['uin', 'text'] },
  },
  {
    name: 'mcp__affinity__affinity_list',
    handler: 'affinity_list',
    write: false,
    description: '只读查看所有人的关系维度概况（不含私聊原文/笔记）。',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  },
];

export function apply(ctx) {
  for (const tool of TOOLS) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      isConcurrencySafe: () => !tool.write,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        return HANDLERS[tool.handler](args ?? {});
      },
    }));
  }
}
