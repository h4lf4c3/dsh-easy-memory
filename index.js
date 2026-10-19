/**
 * dsh-easy-memory — DeepSeek Harness 宿主侧（Host）记忆插件。
 *
 * 三层能力：
 *   1. 用户全局记忆：<DSH_HOME>/easy-memory/，跟人走，可在侧栏记忆面板里可视化增删改；
 *   2. 项目记忆：<工作区根>/.dshmem/，跟项目走，每次对话结束后由会话自己的模型
 *      自动沉淀新条目；
 *   3. 分片归档：项目记忆超过一天或超过容量上限时，旧条目被切到 shards/ 分片，
 *      主索引只保留最近的一批，注入时用主索引，检索时分片按需召回。
 *
 * 本文件只做「组装」：读配置、建立运行期状态、把 section / 事件 / 工具 / 命令 /
 * HTTP 接口挂到宿主上。具体实现按职责放在 lib/ 下：
 *   constants  常量与默认值          util     日志、文本、原子读写、串行锁
 *   config     配置归一化            store    主索引 + 分片
 *   search     检索                  prompt   系统提示词渲染
 *   entry      条目视图与参数校验     promotion 跨工作区晋升
 *   tools      memory_* 工具         commands /memory 命令
 *   turn       journal 与自动沉淀     http     记忆面板后端
 *
 * 工程约束：全插件只使用 Node 内置模块。插件安装在 profile 的 node_modules 下，
 * 宿主安装目录里的 @deepseek-ai/* 包是否对其可解析并不由本插件决定，因此工具定义
 * 直接书写 Harness 强制的 JSON Schema 子集，不导入 defineTool。代价是 defineTool
 * 自带的入参校验没有生效，每个 execute 自行校验参数。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createMemoryCommand } from './lib/commands.js'
import { normalizeConfig } from './lib/config.js'
import { SECTION_NAME, STATE_FILE, STORE_VERSION } from './lib/constants.js'
import { mountMemoryRoutes } from './lib/http.js'
import { renderSectionText } from './lib/prompt.js'
import { createPromotion } from './lib/promotion.js'
import { loadStore, rollIfNeeded, rollReason, storeOf, stores } from './lib/store.js'
import { registerTools } from './lib/tools.js'
import { createTurnPipeline } from './lib/turn.js'
import { dshHome, log, readJson, textOf, writeJsonAtomic } from './lib/util.js'

/** 插件名，供 loader 诊断使用。 */
export const name = 'dsh-easy-memory'

/** 本插件依赖的宿主服务；缺任意一个时插件保持不激活。webServer 与 llm 走可选获取。 */
export const inject = ['tools', 'systemPrompt', 'commands', 'workingDirectory']

/**
 * 注册记忆插件。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} [rawConfig] - profile patch 里该行的 config。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const globalDir = cfg.globalDir !== '' ? cfg.globalDir : join(dshHome(), 'easy-memory')
  const globalTitle = '用户全局记忆 / Global user memory'
  const runtimeState = { enabled: true, loaded: false }
  const statePath = join(globalDir, STATE_FILE)

  /** 记忆目录对应的展示标题；删改后重建 memory.md 时也要用它。 */
  function titleFor(dir) {
    return dir === globalDir ? globalTitle : `项目记忆 / Project memory (${dir})`
  }

  /** 读取运行期开关（/memory off 或记忆面板会写它）。 */
  async function loadRuntimeState() {
    const parsed = await readJson(statePath, undefined)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.enabled === 'boolean') {
      runtimeState.enabled = parsed.enabled
    }
    runtimeState.loaded = true
    return runtimeState
  }

  /** 写运行期开关。 */
  async function saveRuntimeState(enabled) {
    runtimeState.enabled = enabled
    await mkdir(globalDir, { recursive: true })
    await writeJsonAtomic(statePath, { version: STORE_VERSION, enabled, updatedAt: Date.now() })
  }

  /** 记忆功能此刻是否生效（配置开关与运行期开关都要求开启）。 */
  function memoryOn() {
    return cfg.enabled && runtimeState.enabled
  }

  /** 工作区记忆目录。 */
  function workspaceDirOf(root) {
    if (typeof root !== 'string' || root === '') return undefined
    return join(root, cfg.workspaceDirName)
  }

  /** 取某个 agent 当前的工作目录。 */
  function workspaceRootOf(agent) {
    try {
      const session = agent?.session
      if (session !== undefined && ctx.workingDirectory !== undefined) {
        const dir = ctx.workingDirectory.get(session)
        if (typeof dir === 'string' && dir !== '') return dir
      }
    } catch (error) {
      log(`workingDirectory.get failed: ${textOf(error)}`)
    }
    try {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* header 不可读时按未知处理 */
    }
    return undefined
  }

  /** 预读某个 agent 工作区的记忆目录；该会话没有工作目录时什么也不做。 */
  async function preloadWorkspace(agent) {
    const dir = workspaceDirOf(workspaceRootOf(agent))
    if (dir === undefined) return
    await loadStore(dir)
  }

  /** 组装一次注入所需的全部状态。 */
  function snapshotFor(agent) {
    const globalStore = storeOf(globalDir)
    let workspace
    if (agent !== undefined) {
      const root = workspaceRootOf(agent)
      const dir = workspaceDirOf(root)
      if (dir !== undefined) workspace = { root, dir, store: storeOf(dir) }
    }
    return { globalStore, workspace }
  }

  /** 生成某个 agent 视角的注入文本；agent 为空时退化为全局视角。 */
  function textFor(agent) {
    if (!memoryOn()) return ''
    const { globalStore, workspace } = snapshotFor(agent)
    return renderSectionText(cfg, runtimeState, globalStore, workspace)
  }

  // --- 1) 全局 section：即使拿不到 agent 作用域也保证有记忆注入 ------------

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: cfg.sectionOrder,
      text: () => textFor(undefined),
    }),
  )

  // --- 2) 每个 agent 一条同名 section，遮蔽全局那条并带上工作区记忆 --------

  const agentDisposers = new Map()

  /** 释放某个 agent 的作用域注册。 */
  function releaseAgent(agent) {
    const dispose = agentDisposers.get(agent)
    if (dispose === undefined) return
    agentDisposers.delete(agent)
    try {
      dispose()
    } catch (error) {
      log(`failed to release agent scope: ${textOf(error)}`)
    }
  }

  ctx.effect(() =>
    ctx.on('agent/created', async ({ agent }) => {
      try {
        /*
         * 先把这个 agent 会用到的两份记忆读进缓存，再注册 section。
         * agent/created 的监听器会被 await，而 AgentLoop 会扣住排队中的输入，
         * 所以这一步保证了「重启后的第一次请求」也能看到记忆；
         * 否则首次组装会赶在异步读盘完成之前，注入出一个空的记忆段。
         */
        await Promise.all([loadStore(globalDir), preloadWorkspace(agent).catch(() => undefined)])
        const agentCtx = agent?.ctx
        if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return
        const dispose = agentCtx.effect(() => {
          const prompt = agentCtx.get('systemPrompt')
          if (prompt === undefined || typeof prompt.section !== 'function') return () => {}
          return prompt.section({
            name: SECTION_NAME,
            order: cfg.sectionOrder,
            text: () => textFor(agent),
          })
        })
        agentDisposers.set(agent, dispose)
      } catch (error) {
        // agent/created 的监听器抛错会中断 agent 创建，因此这里必须吞掉异常。
        log(`failed to register per-agent memory section: ${textOf(error)}`)
      }
    }),
  )

  ctx.effect(() =>
    ctx.on('agent/disposed', ({ agent }) => {
      releaseAgent(agent)
    }),
  )

  ctx.effect(() => () => {
    for (const agent of [...agentDisposers.keys()]) releaseAgent(agent)
  })

  // --- 3) 周期刷新：外部编辑 memory.json 后无需重启，并检查跨天归档 --------

  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const store of [...stores.values()]) {
        const reason = rollReason(store, cfg)
        if (reason !== undefined) {
          void rollIfNeeded(store, cfg, titleFor(store.dir)).catch((error) =>
            log(`scheduled roll failed: ${textOf(error)}`),
          )
        } else {
          void loadStore(store.dir).catch((error) => log(`refresh failed: ${textOf(error)}`))
        }
      }
      void loadStore(globalDir).catch(() => undefined)
    }, cfg.refreshMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // --- 4) 晋升账本与每轮对话处理 -------------------------------------------

  const promotion = createPromotion({ cfg, globalDir, globalTitle, workspaceDirOf, titleFor })
  const turn = createTurnPipeline({
    ctx,
    cfg,
    globalDir,
    globalTitle,
    workspaceRootOf,
    workspaceDirOf,
    titleFor,
    writeEntry: promotion.writeEntry,
  })

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      if (!memoryOn()) return
      const turnNo = event.data?.turn
      if (cfg.journal) {
        void turn.writeJournal(session, event, turnNo).catch((error) => log(`journal write failed: ${textOf(error)}`))
      }
      if (cfg.autoDistill !== 'off') {
        void turn.distillTurn(session, turnNo).catch((error) => log(`auto distill failed: ${textOf(error)}`))
      }
    }),
  )

  // --- 5) 供工具 / 命令 / 面板共用的运行期接口 -----------------------------

  const rt = {
    ctx,
    cfg,
    globalDir,
    globalTitle,
    statePath,
    memoryOn,
    titleFor,
    workspaceRootOf,
    workspaceDirOf,
    storeOf,
    loadLedger: promotion.loadLedger,
    saveLedger: promotion.saveLedger,
    promoteToGlobal: promotion.promoteToGlobal,
    removeFromWorkspaces: promotion.removeFromWorkspaces,
    writeEntry: promotion.writeEntry,
    promotionStats: promotion.promotionStats,
    distillTurn: turn.distillTurn,
    lastTurnOf: turn.lastTurnOf,
    saveRuntimeState,
    log,
  }

  // --- 6) 模型侧工具、人类侧命令、记忆面板接口 ------------------------------

  registerTools(rt)

  ctx.effect(() => ctx.commands.register(createMemoryCommand(rt)))

  mountMemoryRoutes(rt)

  // --- 7) 启动预热 ---------------------------------------------------------

  void loadRuntimeState()
    .then(() => loadStore(globalDir))
    .then(() => {
      log(
        `ready: global=${globalDir} workspaceDirName=${cfg.workspaceDirName} enabled=${memoryOn()} autoDistill=${cfg.autoDistill}`,
      )
    })
    .catch((error) => log(`startup failed: ${textOf(error)}`))
}
