/**
 * dsh-easy-memory — Client 半（Web）。
 *
 * 它只做一件事：在「设置」里注册一个「记忆」页面，用来可视化管理**全局用户记忆**
 * ——查看、按分类添加、就地改写、删除，以及一键开关记忆。
 *
 * 数据全部来自宿主半注册的 HTTP 路由 /dsh-easy-memory/*。这一页是 root 作用域的，
 * 拿不到具体会话，因此它只管理全局记忆；项目记忆（.dshmem）由 /memory 命令与
 * memory_* 工具维护。
 *
 * 样式只使用宿主主题 token（--dsw-alias-*），不导入任何 Harness Client 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-easy-memory',
  factory(require) {
    const reactModule = require('react')
    const React = typeof reactModule.useState === 'function' ? reactModule : reactModule.default || reactModule
    const h = React.createElement

    const API = '/dsh-easy-memory'
    const KINDS = ['fact', 'preference', 'relationship', 'followup']
    const KIND_LABEL = {
      fact: '事实信息',
      preference: '偏好习惯',
      relationship: '人物关系',
      followup: '跟进事项',
    }

    /** 调用宿主半的设置页接口。 */
    async function api(path, body) {
      const init =
        body === undefined
          ? { method: 'GET' }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(API + path, init)
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`)
      return data
    }

    const S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.6,
      },
      head: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' },
      title: { fontSize: 14, fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '6px 9px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      select: {
        padding: '6px 9px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      button: {
        padding: '5px 11px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      primary: {
        padding: '5px 11px',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 6,
        background: 'var(--dsw-alias-brand-primary)',
        color: '#ffffff',
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      link: {
        padding: '2px 4px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        textDecoration: 'underline',
      },
      danger: {
        padding: '2px 4px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        cursor: 'pointer',
        font: 'inherit',
        textDecoration: 'underline',
      },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      group: { display: 'flex', flexDirection: 'column', gap: 2 },
      groupTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 },
      item: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      itemText: { flex: 1, minWidth: 0, wordBreak: 'break-word' },
      meta: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 14px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        paddingTop: 10,
      },
      badge: {
        display: 'inline-block',
        padding: '0 6px',
        marginRight: 6,
        borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
      },
    }

    /** 设置页里的「记忆」面板。 */
    function MemorySettingsPanel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draftKind, setDraftKind] = React.useState('fact')
      const [draftText, setDraftText] = React.useState('')
      const [editingId, setEditingId] = React.useState('')
      const [editingText, setEditingText] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const next = await api('/summary')
          setState(next)
          setError('')
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const run = React.useCallback(async (operation) => {
        setBusy(true)
        try {
          await operation()
          setError('')
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setBusy(false)
        }
      }, [])

      const onAdd = () =>
        run(async () => {
          const text = draftText.trim()
          if (text === '') return
          const next = await api('/add', { kind: draftKind, text })
          setState(next)
          setDraftText('')
        })

      const onDelete = (id) => run(async () => setState(await api('/delete', { id })))

      const onSaveEdit = () =>
        run(async () => {
          const text = editingText.trim()
          if (text === '') return
          setState(await api('/update', { id: editingId, text }))
          setEditingId('')
          setEditingText('')
        })

      const onToggle = () =>
        run(async () => setState(await api('/toggle', { enabled: !(state && state.enabled) })))

      if (state === null) {
        return h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, '记忆'),
          h('div', { style: S.hint }, error === '' ? '正在读取记忆…' : ''),
          error !== '' ? h('div', { style: S.error }, error) : null,
        )
      }

      const entries = Array.isArray(state.entries) ? state.entries : []
      const children = [
        h(
          'div',
          { key: 'head', style: S.head },
          h(
            'div',
            null,
            h('div', { style: S.title }, '记忆'),
            h('div', { style: S.hint }, '全局记忆跟随你跨工作区；项目记忆存在各工作区的 .dshmem/ 里，用 /memory 命令维护。'),
          ),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              {
                key: 'switch',
                type: 'button',
                role: 'switch',
                'aria-checked': state.enabled ? 'true' : 'false',
                disabled: busy,
                onClick: onToggle,
                style: state.enabled ? S.primary : S.button,
              },
              state.enabled ? '记忆已开启' : '记忆已关闭',
            ),
            h('button', { key: 'refresh', type: 'button', disabled: busy, onClick: () => void refresh(), style: S.button }, '刷新'),
          ),
        ),
      ]

      children.push(
        h(
          'div',
          { key: 'add', style: S.row },
          h(
            'select',
            {
              key: 'kind',
              value: draftKind,
              disabled: busy,
              onChange: (event) => setDraftKind(event.target.value),
              style: S.select,
              'aria-label': '记忆分类',
            },
            KINDS.map((kind) => h('option', { key: kind, value: kind }, KIND_LABEL[kind])),
          ),
          h('input', {
            key: 'text',
            value: draftText,
            disabled: busy,
            placeholder: '新增一条全局记忆，例如：我习惯用 pnpm 而不是 npm',
            onChange: (event) => setDraftText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void onAdd()
            },
            style: S.input,
            'aria-label': '记忆内容',
          }),
          h('button', { key: 'add-button', type: 'button', disabled: busy, onClick: () => void onAdd(), style: S.primary }, '添加'),
        ),
      )

      if (error !== '') children.push(h('div', { key: 'error', style: S.error }, error))

      if (entries.length === 0) {
        children.push(h('div', { key: 'empty', style: S.hint }, '全局记忆当前是空的。'))
      }

      for (const kind of KINDS) {
        const group = entries.filter((entry) => entry.kind === kind)
        if (group.length === 0) continue
        children.push(h('div', { key: `t-${kind}`, style: S.groupTitle }, `${KIND_LABEL[kind]}（${group.length}）`))
        const rows = group.map((entry) => {
          if (editingId === entry.id) {
            return h(
              'div',
              { key: entry.id, style: S.item },
              h('input', {
                value: editingText,
                disabled: busy,
                autoFocus: true,
                onChange: (event) => setEditingText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void onSaveEdit()
                  if (event.key === 'Escape') setEditingId('')
                },
                style: S.input,
                'aria-label': '改写记忆内容',
              }),
              h('button', { type: 'button', disabled: busy, onClick: () => void onSaveEdit(), style: S.primary }, '保存'),
              h('button', { type: 'button', disabled: busy, onClick: () => setEditingId(''), style: S.link }, '取消'),
            )
          }
          return h(
            'div',
            { key: entry.id, style: S.item },
            h(
              'div',
              { style: S.itemText },
              h('span', { style: S.badge }, KIND_LABEL[entry.kind] || entry.kind),
              entry.text,
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => {
                  setEditingId(entry.id)
                  setEditingText(entry.text)
                },
                style: S.link,
              },
              '改写',
            ),
            h('button', { type: 'button', disabled: busy, onClick: () => void onDelete(entry.id), style: S.danger }, '删除'),
          )
        })
        children.push(h('div', { key: `g-${kind}`, style: S.group }, rows))
      }

      children.push(
        h(
          'div',
          { key: 'meta', style: S.meta },
          h('span', null, `目录：${state.globalDir}`),
          h('span', null, `活动区日期：${state.activeDate || '—'}`),
          h('span', null, `归档分片：${Array.isArray(state.shards) ? state.shards.length : 0} 个`),
          h('span', null, `自动沉淀：${state.autoDistill}`),
          h('span', null, `注入范围：${state.scope}`),
          h(
            'span',
            null,
            state.promotions
              ? `全局晋升：${state.promotions.candidates} 候选 / ${state.promotions.promoted} 已晋升（阈值 ${state.promotions.threshold} 个工作区，模式 ${state.promotions.mode}）`
              : '全局晋升：—',
          ),
        ),
      )

      return h('div', { style: S.card }, children)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-easy-memory', order: 60, label: '记忆' },
            MemorySettingsPanel,
          ),
        )
      },
    }
  },
})
