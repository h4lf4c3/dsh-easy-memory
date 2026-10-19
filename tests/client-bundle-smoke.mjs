/**
 * Client bundle 冒烟测试：在 Node 里用假的 ModuleLoader / React / ctx 装上
 * client.js，确认语言字典、侧栏行与主区面板都注册成功。
 *
 * 它验证的是模块接线，不是视觉效果；浏览器里的渲染仍需页面确认。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let registration
const window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
new Function('window', source)(window)

assert.equal(registration.id, 'dsh-easy-memory')

const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const modules = { react: fakeReact }
const plugin = registration.factory((id) => {
  if (id in modules) return modules[id]
  throw new Error(`unexpected require: ${id}`)
})

assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout'])
assert.equal(typeof plugin.apply, 'function')

const registrations = []
const dictionaries = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
    bind: () => (key) => key,
  },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  layout: { selectPanel: () => {} },
}

plugin.apply(ctx)

assert.equal(dictionaries.length, 1)
assert.equal(dictionaries[0].ns, 'dsh-easy-memory')
assert.ok(dictionaries[0].dicts.zh.nav)
assert.ok(dictionaries[0].dicts.en.nav)

const row = registrations.find((item) => item.options.name === 'sidebar.panellist')
const page = registrations.find((item) => item.options.name === 'main')
assert.equal(row.options.id, 'memory')
assert.equal(row.options.order, 5)
assert.equal(typeof row.options.label, 'function')
assert.equal(typeof row.component, 'function')
assert.equal(page.options.key, 'memory')
assert.equal(typeof page.component, 'function')

console.log('client bundle OK: dictionaries + sidebar row + main panel registered')
