// Pluto 状态看板 · 客户端半
//
// 挂到 settings.section，作为「Pluto 状态」设置页；数据来自同源 GET /pluto/status。
// 刻意不用 iframe、不读别的插件的 DOM：整页就是普通 React 组件 + 主题 token。
window.__ModuleLoader__.load({
  id: 'pluto-status',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      card: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l1)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    const fmtTime = (ms) => {
      if (!ms) return '—';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const fmtNum = (n) => {
      const v = Number(n) || 0;
      if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
      if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
      return String(v);
    };

    function Card(props) {
      return h('div', {
        style: {
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: '12px 14px',
          minWidth: 0,
        },
      }, props.children);
    }

    function CardTitle(props) {
      return h('div', {
        style: { color: C.muted, fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: 0.2 },
      }, props.children);
    }

    function Row(props) {
      return h('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', gap: 12,
          fontSize: 13, lineHeight: '22px', color: C.text,
        },
      },
        h('span', { style: { color: props.strong ? C.text : C.muted, flex: '0 0 auto' } }, props.label),
        h('span', { style: { textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.value),
      );
    }

    function StatusPage() {
      const [state, setState] = React.useState({ phase: 'loading' });
      const [saving, setSaving] = React.useState(false);
      const [saveError, setSaveError] = React.useState(null);

      const saveMode = async (next) => {
        setSaving(true);
        setSaveError(null);
        try {
          const res = await fetch(`${location.origin}/pluto/mode`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: next }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setState((prev) => (prev.phase === 'ready'
            ? { phase: 'ready', data: { ...prev.data, mode: data } }
            : prev));
        } catch (error) {
          setSaveError(String(error && error.message || error));
        } finally {
          setSaving(false);
        }
      };

      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const res = await fetch(`${location.origin}/pluto/status`, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data && data.ok === false) throw new Error(data.error || '接口返回失败');
            if (alive) setState({ phase: 'ready', data });
          } catch (error) {
            if (alive) setState({ phase: 'error', error: String(error && error.message || error) });
          }
        };
        load();
        const timer = setInterval(load, 15000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      const header = h('div', { style: { marginBottom: 14 } },
        h('div', { style: { fontSize: 16, fontWeight: 600, color: C.text } }, 'Pluto 状态'),
        h('div', { style: { fontSize: 12, color: C.muted, marginTop: 4 } },
          '只读 · 每 15 秒刷新 · 数据来自桥接的 state 文件'),
      );

      if (state.phase === 'loading') {
        return h('div', { style: { padding: '8px 0' } }, header,
          h('div', { style: { fontSize: 13, color: C.muted } }, '读取中…'));
      }
      if (state.phase === 'error') {
        return h('div', { style: { padding: '8px 0' } }, header,
          h('div', { style: { fontSize: 13, color: C.error } }, `读取失败：${state.error}`),
          h('div', { style: { fontSize: 12, color: C.muted, marginTop: 6 } },
            '确认桥接正在运行，且 profile 里 pluto-status 已启用。'));
      }

      const d = state.data;
      const convs = Array.isArray(d.conversations) ? d.conversations : [];
      const affinity = Array.isArray(d.affinityTop) ? d.affinityTop : [];
      const tokens = d.tokens || {};
      const live = d.live || {};

      return h('div', { style: { padding: '8px 0', color: C.text } },
        header,
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
          },
        },
          h(Card, null,
            h(CardTitle, null, '网关'),
            h(Row, { label: '状态', value: d.bridge && d.bridge.paused ? '已暂停' : '运行中', strong: true }),
            h(Row, { label: '会话数', value: convs.length }),
            h(Row, { label: '快照时间', value: fmtTime(d.generatedAt) }),
          ),
          h(Card, null,
            h(CardTitle, null, '模式（qq-mode）'),
            d.mode && d.mode.available
              ? h('div', null,
                  h('div', { style: { fontSize: 13, color: C.text, marginBottom: 8 } },
                    `当前：${d.mode.mode ?? '—'}`),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    (d.mode.modes || []).map((m) => h('button', {
                      key: m,
                      type: 'button',
                      disabled: saving,
                      onClick: () => saveMode(m),
                      style: {
                        fontSize: 12,
                        padding: '4px 10px',
                        borderRadius: 6,
                        cursor: saving ? 'default' : 'pointer',
                        color: m === d.mode.mode ? C.card : C.text,
                        background: m === d.mode.mode ? C.accent : 'var(--dsw-alias-bg-layer-2)',
                        border: `1px solid ${C.border}`,
                        opacity: saving ? 0.6 : 1,
                      },
                    }, m)),
                  ),
                  saveError ? h('div', { style: { fontSize: 12, color: C.error, marginTop: 6 } }, saveError) : null,
                )
              : h('div', { style: { fontSize: 12, color: C.muted } },
                  (d.mode && d.mode.reason) || '不可用'),
          ),
          h(Card, null,
            h(CardTitle, null, '今日用量'),
            h(Row, { label: '调用', value: tokens.available ? `${fmtNum(tokens.todayCalls)} 次` : '无数据' }),
            h(Row, { label: '输入', value: tokens.available ? fmtNum(tokens.input) : '—' }),
            h(Row, { label: '输出', value: tokens.available ? fmtNum(tokens.output) : '—' }),
          ),
          h(Card, null,
            h(CardTitle, null, '直播'),
            h(Row, { label: '主播', value: live.name ? `${live.nick || ''} ${live.name}`.trim() : '—' }),
            h(Row, { label: '状态', value: live.lastStatus === 1 ? '直播中' : '未开播' }),
            h(Row, { label: '最近开播', value: fmtTime(live.lastLiveAt) }),
          ),
          h(Card, null,
            h(CardTitle, null, '发图配额'),
            h(Row, { label: '窗口内', value: `${d.images && d.images.windowItems || 0} 张` }),
            h(Row, { label: '近 24 小时', value: `${d.images && d.images.last24h || 0} 张` }),
            h(Row, { label: '会话', value: String(Object.keys(d.images && d.images.byConversation || {}).length) }),
          ),
        ),
        convs.length ? h('div', { style: { marginTop: 14 } },
          h(CardTitle, null, '会话与唤醒'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 } },
            convs.map((c) => h(Card, { key: c.key },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, c.key),
              h(Row, { label: '模式', value: c.mode || '—' }),
              h(Row, { label: '未读', value: String(c.unread ?? 0) }),
              h(Row, { label: '最近唤醒', value: c.lastWakeReason || '—' }),
              h(Row, { label: '唤醒时间', value: fmtTime(c.lastWakeAt) }),
              h(Row, { label: '厌烦峰值', value: c.annoyanceTop && c.annoyanceTop.length ? `${c.annoyanceTop[0].score}` : '0' }),
              h(Row, { label: '冷落中', value: String(c.muted ?? 0) }),
            )),
          ),
        ) : null,
        affinity.length ? h('div', { style: { marginTop: 14 } },
          h(CardTitle, null, '好感度 Top'),
          h(Card, null,
            affinity.map((a) => h(Row, {
              key: a.uin,
              label: a.uin,
              value: `${a.score} 分 · 互动 ${a.interactions ?? 0}`,
            })),
          ),
        ) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'pluto-status',
          order: 30,
          label: 'Pluto 状态',
        }, StatusPage));
      },
    };
  },
});
