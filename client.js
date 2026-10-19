/**
 * dsh-easy-memory — Client 半（Web）。
 *
 * 它做两件事，合起来就是侧栏里的一个「记忆」入口：
 *   1. 在 `sidebar.panellist` 挂一行（图标 + 标题），与宿主自带的「插件」
 *      「Skill/MCP」「自动化任务」并排；
 *   2. 在中央主区 `main` 用同一个 id 注册整页内容——点侧栏那行，主区就切到记忆页
 *      （不是设置里的模态框）。
 *
 * 数据全部来自宿主半注册的 HTTP 路由 /dsh-easy-memory/*。页是 root 作用域的，
 * 拿不到具体会话，因此只管理全局记忆；项目记忆（.dshmem）由 /memory 命令与
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

    const NS = 'dsh-easy-memory'
    const PANEL_ID = 'memory'
    const API = '/dsh-easy-memory'
    const KINDS = ['fact', 'preference', 'relationship', 'followup']

    const zh = {
      nav: '记忆',
      title: '记忆',
      intro: '全局记忆跨工作区共享，会自动注入系统提示词。项目记忆保存在各工作区根目录的 .dshmem/ 里，用 /memory 命令维护。',
      back: '返回会话',
      refresh: '刷新',
      switchAria: '开关记忆',
      on: '记忆已开启',
      off: '记忆已关闭',
      addAction: '添加记忆',
      newTitle: '新增记忆',
      editTitle: '改写记忆',
      kindLabel: '分类',
      textLabel: '内容',
      textPlaceholder: '写清楚一条值得长期记住的信息，例如：这个项目的提交信息一律用中文。',
      dialogHint: 'Ctrl + Enter 保存，Esc 取消',
      emptyText: '内容不能为空。',
      toolbarHint: '全局记忆只在这一页维护；项目记忆用 /memory 命令。',
      loading: '正在读取记忆…',
      emptyTitle: '还没有全局记忆',
      emptyHint: '点「添加记忆」写一条，或在对话中让 Agent 自动沉淀。',
      statTotal: '全局记忆',
      statShards: '归档分片',
      statDistill: '自动沉淀',
      statScope: '注入范围',
      kindFact: '事实信息',
      kindPreference: '偏好习惯',
      kindRelationship: '人物关系',
      kindFollowup: '跟进事项',
      edit: '改写',
      save: '保存',
      cancel: '取消',
      remove: '删除',
      confirmRemove: '确认删除',
      source: '来源',
      updated: '更新于',
      hits: '命中',
      sourceAuto: '自动沉淀',
      sourcePromotion: '跨工作区晋升',
      sourcePanel: '面板添加',
      sourceCommand: '命令添加',
      sourceImport: '命令导入',
      sourceUnknown: '未知',
      metaDir: '全局目录',
      metaActiveDate: '活动区日期',
      metaPromotions: '全局晋升',
      offNotice: '记忆已关闭：现有条目仍然可见，但不会再注入提示词，也不会自动沉淀。',
      configOffNotice: '配置里 enabled: false 关掉了记忆，需要改 cordis.patch.yml 才会真正恢复。',
    }

    const en = {
      nav: 'Memory',
      title: 'Memory',
      intro:
        'Global memory follows you across workspaces and is injected into the system prompt. Project memory lives in .dshmem/ inside each workspace and is maintained with the /memory command.',
      back: 'Back to conversation',
      refresh: 'Refresh',
      switchAria: 'Toggle memory',
      on: 'Memory on',
      off: 'Memory off',
      addAction: 'Add memory',
      newTitle: 'New memory',
      editTitle: 'Edit memory',
      kindLabel: 'Kind',
      textLabel: 'Content',
      textPlaceholder: 'Write one thing worth remembering long-term, for example: commit messages in this project are always in Chinese.',
      dialogHint: 'Ctrl + Enter to save, Esc to cancel',
      emptyText: 'Content cannot be empty.',
      toolbarHint: 'Global memory is maintained on this page only; use /memory for project memory.',
      loading: 'Reading memory…',
      emptyTitle: 'No global memory yet',
      emptyHint: 'Pick "Add memory", or let the agent distil memories from your conversations.',
      statTotal: 'Global entries',
      statShards: 'Archived shards',
      statDistill: 'Auto-distill',
      statScope: 'Injected scope',
      kindFact: 'Facts',
      kindPreference: 'Preferences',
      kindRelationship: 'Relationships',
      kindFollowup: 'Follow-ups',
      edit: 'Edit',
      save: 'Save',
      cancel: 'Cancel',
      remove: 'Delete',
      confirmRemove: 'Delete?',
      source: 'Source',
      updated: 'Updated',
      hits: 'Hits',
      sourceAuto: 'Auto-distilled',
      sourcePromotion: 'Promoted',
      sourcePanel: 'Added here',
      sourceCommand: 'Command',
      sourceImport: 'Imported',
      sourceUnknown: 'Unknown',
      metaDir: 'Global directory',
      metaActiveDate: 'Active since',
      metaPromotions: 'Promotion',
      offNotice: 'Memory is off: existing entries stay visible, but nothing is injected or auto-distilled.',
      configOffNotice: 'The config sets enabled: false, so change cordis.patch.yml to really turn memory back on.',
    }

    const KIND_KEY = {
      fact: 'kindFact',
      preference: 'kindPreference',
      relationship: 'kindRelationship',
      followup: 'kindFollowup',
    }

    const SOURCE_KEY = {
      'auto-distill': 'sourceAuto',
      promotion: 'sourcePromotion',
      settings: 'sourcePanel',
      command: 'sourceCommand',
      'command-import': 'sourceImport',
    }

    /** 把更新时间渲染成稳定的本地短格式（不依赖 Intl 的 locale 名称）。 */
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
        date.getMinutes(),
      )}`
    }

    const CSS = `
.EM_page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;gap:22px;padding:24px clamp(20px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.EM_page>:not(.EM_overlay){width:100%;max-width:760px;flex:0 0 auto}
.EM_top{min-height:20px;display:flex;align-items:center}
.EM_back{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);background:none;border:0;padding:0;cursor:pointer}
.EM_back:hover{color:var(--dsw-alias-label-primary)}
.EM_back:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.EM_head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.EM_titles{display:flex;flex-direction:column;gap:4px;min-width:0}
.EM_title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.EM_intro{margin:0;max-width:560px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.EM_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.EM_switchRow{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.EM_switch{position:relative;width:34px;height:20px;flex:none;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s,border-color .15s}
.EM_switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}
.EM_switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.EM_switch[aria-checked=true]::after{transform:translateX(14px)}
.EM_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.EM_switch:disabled{opacity:.5;cursor:default}
.EM_btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;line-height:18px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}
.EM_btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.EM_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.EM_btn:disabled{opacity:.45;cursor:default}
.EM_btnPrimary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#ffffff}
.EM_btnPrimary:hover{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.EM_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.EM_stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.EM_statValue{font-size:16px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.EM_statLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.EM_notice{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.EM_toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.EM_toolbarHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.EM_select{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;min-width:0;width:100%;box-sizing:border-box}
.EM_textarea{width:100%;box-sizing:border-box;min-height:168px;resize:vertical;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}
.EM_select:focus-visible,.EM_textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.EM_hint{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.EM_error{padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.EM_overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.EM_dialog{display:flex;flex-direction:column;gap:14px;width:600px;max-width:100%;max-height:calc(100vh - 48px);overflow:auto;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.3)}
.EM_dialogTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
.EM_field{display:flex;flex-direction:column;gap:6px}
.EM_fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.EM_dialogFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.EM_dialogHint{margin:0;flex:1;min-width:150px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.EM_group{display:flex;flex-direction:column;gap:8px}
.EM_groupHead{display:flex;align-items:baseline;gap:8px}
.EM_groupTitle{margin:0;font-size:12px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}
.EM_count{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.EM_list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.EM_item{display:flex;align-items:flex-start;gap:10px;padding:12px 14px}
.EM_item+.EM_item{border-top:1px solid var(--dsw-alias-border-l1)}
.EM_item:hover{background:var(--dsw-alias-bg-layer-2)}
.EM_chip{flex:none;margin-top:1px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.EM_itemBody{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.EM_itemText{word-break:break-word}
.EM_itemMeta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.EM_itemActions{display:flex;align-items:center;gap:2px;flex:none}
.EM_rowBtn{font:inherit;font-size:12px;line-height:18px;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.EM_rowBtn:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.EM_rowBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.EM_rowBtn[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.EM_empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);text-align:center}
.EM_emptyTitle{font-size:14px;font-weight:600}
.EM_emptyHint{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.EM_meta{display:flex;flex-wrap:wrap;gap:6px 18px;padding:12px 2px 0;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.EM_metaPair{display:inline-flex;gap:6px;min-width:0;max-width:100%}
.EM_metaValue{color:var(--dsw-alias-label-primary);word-break:break-all}
`

    /** 调用宿主半的面板接口。 */
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

    /** 侧栏行的字形：三层记忆片，颜色跟随宿主侧栏行的 currentColor。 */
    function PanelGlyph(props) {
      const edge = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M8 2.4 13.2 5.2 8 8 2.8 5.2 8 2.4Z' }),
        h('path', { d: 'M2.8 8 8 10.8 13.2 8' }),
        h('path', { d: 'M2.8 10.8 8 13.6 13.2 10.8' }),
      )
    }

    /** 空状态里的大号同款字形。 */
    function EmptyGlyph() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 26,
          height: 26,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', color: 'var(--dsw-alias-label-secondary)' },
        },
        h('path', { d: 'M8 2.4 13.2 5.2 8 8 2.8 5.2 8 2.4Z' }),
        h('path', { d: 'M2.8 8 8 10.8 13.2 8' }),
        h('path', { d: 'M2.8 10.8 8 13.6 13.2 10.8' }),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-easy-memory: locale dictionaries')

        /** 当前语言的翻译函数；语言切换时重新渲染。 */
        function useTranslate() {
          const [, bump] = React.useState(0)
          React.useEffect(() => {
            const dispose = ctx.locale.subscribe(() => bump((value) => value + 1))
            return typeof dispose === 'function' ? dispose : undefined
          }, [])
          return ctx.locale.bind(NS)
        }

        /** 主区返回会话：layout.selectPanel(null) 把中央主区还给 Conversation。 */
        function backToConversation() {
          const layout = ctx.layout
          if (layout !== null && typeof layout === 'object' && typeof layout.selectPanel === 'function') {
            layout.selectPanel(null)
          }
        }

        function MemoryPage() {
          const t = useTranslate()
          const [state, setState] = React.useState(null)
          const [error, setError] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [editor, setEditor] = React.useState(null)
          const [confirmId, setConfirmId] = React.useState('')

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

          /** 打开编辑器：新增为空草稿，改写带出原分类与原文。 */
          const openEditor = (kind, text, id) => {
            setConfirmId('')
            setEditor({ mode: id === undefined ? 'add' : 'edit', id: id === undefined ? '' : id, kind, text, busy: false, error: '' })
          }

          /** 编辑器保存：新增走 /add，改写走 /update（分类也一起提交）。 */
          const saveEditor = async () => {
            if (editor === null || editor.busy) return
            const text = editor.text.trim()
            if (text === '') {
              setEditor({ ...editor, error: t('emptyText') })
              return
            }
            setEditor({ ...editor, busy: true, error: '' })
            try {
              const next =
                editor.mode === 'add'
                  ? await api('/add', { kind: editor.kind, text })
                  : await api('/update', { id: editor.id, kind: editor.kind, text })
              setState(next)
              setError('')
              setEditor(null)
            } catch (cause) {
              setEditor({ ...editor, busy: false, error: String((cause && cause.message) || cause) })
            }
          }

          const onDelete = (id) =>
            run(async () => {
              setState(await api('/delete', { id }))
              setConfirmId('')
            })

          const onToggle = () =>
            run(async () => setState(await api('/toggle', { enabled: !(state && state.enabled) })))

          const children = [h('style', { key: 'em-css' }, CSS)]

          children.push(
            h(
              'div',
              { key: 'top', className: 'EM_top' },
              h(
                'button',
                { type: 'button', className: 'EM_back', onClick: backToConversation, title: t('back') },
                h(
                  'svg',
                  {
                    viewBox: '0 0 16 16',
                    width: 14,
                    height: 14,
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.6,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    'aria-hidden': 'true',
                    focusable: 'false',
                  },
                  h('path', { d: 'M10 3.5 5.5 8l4.5 4.5' }),
                ),
                h('span', null, t('back')),
              ),
            ),
          )

          children.push(
            h(
              'header',
              { key: 'head', className: 'EM_head' },
              h(
                'div',
                { className: 'EM_titles' },
                h('h1', { className: 'EM_title' }, t('title')),
                h('p', { className: 'EM_intro' }, t('intro')),
              ),
              h(
                'div',
                { className: 'EM_actions' },
                h(
                  'span',
                  { className: 'EM_switchRow' },
                  h('button', {
                    type: 'button',
                    className: 'EM_switch',
                    role: 'switch',
                    'aria-checked': state && state.enabled ? 'true' : 'false',
                    'aria-label': t('switchAria'),
                    disabled: busy || state === null,
                    onClick: onToggle,
                  }),
                  h('span', null, state && state.enabled ? t('on') : t('off')),
                ),
                h(
                  'button',
                  { type: 'button', className: 'EM_btn', disabled: busy || state === null, onClick: () => void refresh() },
                  t('refresh'),
                ),
              ),
            ),
          )

          if (state === null) {
            children.push(h('div', { key: 'loading', className: 'EM_hint' }, error === '' ? t('loading') : ''))
            if (error !== '') children.push(h('div', { key: 'loadError', className: 'EM_error' }, error))
            return h('div', { className: 'EM_page' }, children)
          }

          const entries = (Array.isArray(state.entries) ? state.entries : [])
            .slice()
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          const shards = Array.isArray(state.shards) ? state.shards : []

          children.push(
            h(
              'section',
              { key: 'stats', className: 'EM_stats' },
              h(
                'div',
                { className: 'EM_stat' },
                h('div', { className: 'EM_statValue' }, String(entries.length)),
                h('div', { className: 'EM_statLabel' }, t('statTotal')),
              ),
              h(
                'div',
                { className: 'EM_stat' },
                h('div', { className: 'EM_statValue' }, String(shards.length)),
                h('div', { className: 'EM_statLabel' }, t('statShards')),
              ),
              h(
                'div',
                { className: 'EM_stat' },
                h('div', { className: 'EM_statValue' }, String(state.autoDistill ?? '—')),
                h('div', { className: 'EM_statLabel' }, t('statDistill')),
              ),
              h(
                'div',
                { className: 'EM_stat' },
                h('div', { className: 'EM_statValue' }, String(state.scope ?? '—')),
                h('div', { className: 'EM_statLabel' }, t('statScope')),
              ),
            ),
          )

          if (state.enabled === false) {
            children.push(h('div', { key: 'offNotice', className: 'EM_notice' }, t('offNotice')))
          }
          if (state.configEnabled === false) {
            children.push(h('div', { key: 'configOff', className: 'EM_notice' }, t('configOffNotice')))
          }

          children.push(
            h(
              'section',
              { key: 'toolbar', className: 'EM_toolbar' },
              h('p', { className: 'EM_toolbarHint' }, t('toolbarHint')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'EM_btn EM_btnPrimary',
                  disabled: busy,
                  onClick: () => openEditor('fact', ''),
                },
                h(
                  'svg',
                  {
                    viewBox: '0 0 16 16',
                    width: 12,
                    height: 12,
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.8,
                    strokeLinecap: 'round',
                    'aria-hidden': 'true',
                    focusable: 'false',
                  },
                  h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' }),
                ),
                t('addAction'),
              ),
            ),
          )

          if (error !== '') children.push(h('div', { key: 'error', className: 'EM_error' }, error))

          if (entries.length === 0) {
            children.push(
              h(
                'div',
                { key: 'empty', className: 'EM_empty' },
                h(EmptyGlyph),
                h('div', { className: 'EM_emptyTitle' }, t('emptyTitle')),
                h('div', { className: 'EM_emptyHint' }, t('emptyHint')),
              ),
            )
          }

          for (const kind of KINDS) {
            const group = entries.filter((entry) => entry.kind === kind)
            if (group.length === 0) continue

            const rows = group.map((entry) => {
              const meta = []
              const sourceKey = entry && entry.source ? SOURCE_KEY[entry.source.via] : undefined
              if (entry && entry.source) meta.push(`${t('source')} ${t(sourceKey === undefined ? 'sourceUnknown' : sourceKey)}`)
              const updated = formatTime(entry.updatedAt)
              if (updated !== '') meta.push(`${t('updated')} ${updated}`)
              if (typeof entry.hits === 'number' && entry.hits > 1) meta.push(`${t('hits')} ×${entry.hits}`)

              const confirming = confirmId === entry.id

              return h(
                'div',
                { key: entry.id, className: 'EM_item' },
                h('span', { className: 'EM_chip' }, t(KIND_KEY[kind])),
                h(
                  'div',
                  { className: 'EM_itemBody' },
                  h('div', { className: 'EM_itemText' }, entry.text),
                  meta.length === 0 ? null : h('div', { className: 'EM_itemMeta' }, meta.join(' · ')),
                ),
                h(
                  'div',
                  { className: 'EM_itemActions' },
                  confirming
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'EM_rowBtn',
                            'data-danger': 'true',
                            disabled: busy,
                            onClick: () => void onDelete(entry.id),
                          },
                          t('confirmRemove'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'EM_rowBtn',
                            disabled: busy,
                            onClick: () => setConfirmId(''),
                          },
                          t('cancel'),
                        ),
                      )
                    : h(
                        React.Fragment,
                        null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'EM_rowBtn',
                            disabled: busy,
                            onClick: () => openEditor(entry.kind, entry.text, entry.id),
                          },
                          t('edit'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'EM_rowBtn',
                            disabled: busy,
                            onClick: () => setConfirmId(entry.id),
                          },
                          t('remove'),
                        ),
                      ),
                ),
              )
            })

            children.push(
              h(
                'section',
                { key: `group-${kind}`, className: 'EM_group' },
                h(
                  'div',
                  { className: 'EM_groupHead' },
                  h('h2', { className: 'EM_groupTitle' }, t(KIND_KEY[kind])),
                  h('span', { className: 'EM_count' }, String(group.length)),
                ),
                h('div', { className: 'EM_list' }, rows),
              ),
            )
          }

          children.push(
            h(
              'footer',
              { key: 'meta', className: 'EM_meta' },
              h(
                'span',
                { className: 'EM_metaPair' },
                h('span', null, t('metaDir')),
                h('span', { className: 'EM_metaValue' }, state.globalDir),
              ),
              h(
                'span',
                { className: 'EM_metaPair' },
                h('span', null, t('metaActiveDate')),
                h('span', { className: 'EM_metaValue' }, state.activeDate || '—'),
              ),
              h(
                'span',
                { className: 'EM_metaPair' },
                h('span', null, t('metaPromotions')),
                h(
                  'span',
                  { className: 'EM_metaValue' },
                  state.promotions
                    ? `${state.promotions.candidates} / ${state.promotions.promoted} · ${state.promotions.threshold} · ${state.promotions.mode}`
                    : '—',
                ),
              ),
            ),
          )

          if (editor !== null) {
            const closeEditor = () => {
              if (!editor.busy) setEditor(null)
            }
            children.push(
              h(
                'div',
                {
                  key: 'editor',
                  className: 'EM_overlay',
                  onClick: (event) => {
                    if (event.target === event.currentTarget) closeEditor()
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      closeEditor()
                    }
                  },
                },
                h(
                  'div',
                  {
                    className: 'EM_dialog',
                    role: 'dialog',
                    'aria-modal': 'true',
                    'aria-labelledby': 'em-dialog-title',
                  },
                  h(
                    'h2',
                    { className: 'EM_dialogTitle', id: 'em-dialog-title' },
                    editor.mode === 'add' ? t('newTitle') : t('editTitle'),
                  ),
                  h(
                    'div',
                    { className: 'EM_field' },
                    h('label', { className: 'EM_fieldLabel', htmlFor: 'em-editor-kind' }, t('kindLabel')),
                    h(
                      'select',
                      {
                        id: 'em-editor-kind',
                        className: 'EM_select',
                        value: editor.kind,
                        disabled: editor.busy,
                        onChange: (event) => setEditor({ ...editor, kind: event.target.value }),
                      },
                      KINDS.map((kind) => h('option', { key: kind, value: kind }, t(KIND_KEY[kind]))),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'EM_field' },
                    h('label', { className: 'EM_fieldLabel', htmlFor: 'em-editor-text' }, t('textLabel')),
                    h('textarea', {
                      id: 'em-editor-text',
                      className: 'EM_textarea',
                      value: editor.text,
                      disabled: editor.busy,
                      autoFocus: true,
                      placeholder: t('textPlaceholder'),
                      onChange: (event) => setEditor({ ...editor, text: event.target.value }),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault()
                          void saveEditor()
                        }
                      },
                    }),
                  ),
                  editor.error === ''
                    ? null
                    : h('div', { className: 'EM_error', role: 'alert' }, editor.error),
                  h(
                    'div',
                    { className: 'EM_dialogFooter' },
                    h('p', { className: 'EM_dialogHint' }, t('dialogHint')),
                    h(
                      'button',
                      { type: 'button', className: 'EM_btn', disabled: editor.busy, onClick: closeEditor },
                      t('cancel'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'EM_btn EM_btnPrimary',
                        disabled: editor.busy || editor.text.trim() === '',
                        onClick: () => void saveEditor(),
                      },
                      t('save'),
                    ),
                  ),
                ),
              ),
            )
          }

          return h('div', { className: 'EM_page' }, children)
        }

        // 侧栏面板行：order 5 落在宿主「Skill/MCP」（1）和「自动化任务」（10）之间。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 5,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            PanelGlyph,
          ),
        )

        // 中央主区页面：key 必须与侧栏行的 id 一致，否则选中时宿主找不到内容。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MemoryPage),
        )
      },
    }
  },
})
