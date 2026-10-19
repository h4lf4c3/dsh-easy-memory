/**
 * 冒烟测试：用一个假的 ctx 驱动 apply()，走一遍工具、命令与面板接口。
 *
 * 目的不是覆盖所有分支，而是保证 Host 侧的模块拆分之后插件仍然能装配起来：
 * 四个工具、一条 /memory 命令、五条面板路由都在，且真实读写落在临时目录里。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-easy-memory-smoke-'))

function createHarness(workspace) {
  const tools = []
  const commands = []
  const routes = []
  const disposers = []
  const listeners = new Map()
  const webServer = { register: (route) => (routes.push(route), () => {}) }
  const ctx = {
    tools: { register: (definition) => (tools.push(definition), () => {}) },
    commands: { register: (definition) => (commands.push(definition), () => {}) },
    systemPrompt: { section: () => () => {} },
    workingDirectory: { get: () => workspace },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on(event, fn) {
      listeners.set(event, fn)
      return () => {}
    },
    inject(_dependencies, callback) {
      callback({ webServer, effect: (fn) => ctx.effect(fn) })
      return () => {}
    },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {} },
  }
  return { ctx, tools, commands, routes, disposers, listeners }
}

async function callRoute(routes, path, body) {
  const route = routes.find((item) => item.path === `/dsh-easy-memory${path}`)
  if (route === undefined) throw new Error(`route not mounted: ${path}`)
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  let status = 0
  let payload = ''
  const response = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      payload = String(chunk)
    },
  }
  await route.handler(request, response)
  return { status, body: payload === '' ? null : JSON.parse(payload) }
}

const harness = createHarness(join(root, 'workspace'))
const originalError = console.error
console.error = () => {}

try {
  apply(harness.ctx, { globalDir: join(root, 'global'), autoDistill: 'off', refreshMs: 3_600_000 })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const names = harness.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['memory_forget', 'memory_search', 'memory_status', 'memory_write'])
  assert.equal(harness.commands.length, 1)
  assert.equal(harness.commands[0].name, 'memory')
  assert.equal(harness.routes.length, 5)

  const tool = (name) => harness.tools.find((item) => item.name === name)
  const exec = { agent: { id: 'session-smoke', session: {} } }

  let summary = await callRoute(harness.routes, '/summary')
  assert.equal(summary.status, 200)
  assert.equal(summary.body.entries.length, 0)

  let added = await callRoute(harness.routes, '/add', { kind: 'fact', text: 'smoke entry' })
  assert.equal(added.status, 200)
  assert.equal(added.body.entries.length, 1)
  assert.equal(added.body.entries[0].text, 'smoke entry')
  const id = added.body.entries[0].id

  const updated = await callRoute(harness.routes, '/update', { id, text: 'smoke entry updated', kind: 'preference' })
  assert.equal(updated.body.entries[0].text, 'smoke entry updated')
  assert.equal(updated.body.entries[0].kind, 'preference')

  const disabled = await callRoute(harness.routes, '/toggle', { enabled: false })
  assert.equal(disabled.body.enabled, false)
  const enabled = await callRoute(harness.routes, '/toggle', { enabled: true })
  assert.equal(enabled.body.enabled, true)

  const status = await tool('memory_status').execute({}, exec)
  assert.equal(status.globalDir, join(root, 'global'))
  assert.equal(status.globalCount, 1)
  assert.equal(status.configEnabled, true)

  const written = await tool('memory_write').execute(
    { scope: 'global', kind: 'fact', text: 'tool write works' },
    exec,
  )
  assert.equal(written.deduped, false)

  const found = await tool('memory_search').execute({ query: 'tool write' }, exec)
  assert.equal(found.returned, 1)
  assert.equal(found.entries[0].text, 'tool write works')

  const removed = await tool('memory_forget').execute({ query: 'tool write' }, exec)
  assert.equal(removed.removed.length, 1)

  const help = await harness.commands[0].handler({ rawInput: 'help' })
  assert.equal(help.kind, 'success')
  assert.match(help.text, /\/memory path/)

  const path = await harness.commands[0].handler({ rawInput: 'path' })
  assert.match(path.text, /记忆面板/)
  assert.match(path.text, /global/)

  const show = await harness.commands[0].handler({ rawInput: 'show' })
  assert.equal(show.kind, 'success')

  const deleted = await callRoute(harness.routes, '/delete', { id })
  assert.equal(deleted.body.removed, 1)
  assert.equal(deleted.body.entries.length, 0)

  console.error = originalError
  console.log('smoke OK: 4 tools, 1 command, 5 routes, global store read/write works')
} finally {
  console.error = originalError
  for (const dispose of harness.disposers) {
    try {
      dispose()
    } catch {
      /* 清理失败不影响结论 */
    }
  }
  await rm(root, { recursive: true, force: true })
}
