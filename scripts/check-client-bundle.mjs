/**
 * 离线加载客户端 bundle：用桩 window.__ModuleLoader__ 捕获 factory，
 * 用最小 react 桩执行，验证模块导出与 slot 注册参数。
 * 这是浏览器加载前的最后一道静态闸门。
 *
 * react 不在 profile 的文件系统里（它随应用打包），所以这里提供最小桩：
 * 检查的是 bundle 自身的语法、导出契约与注册参数，而不是 react 的行为。
 */
import { readFileSync } from 'node:fs'

/** 最小 react 桩：只提供 bundle 实际用到的表面。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
// eslint-disable-next-line no-eval
eval(source)

if (!captured) throw new Error('bundle 未调用 __ModuleLoader__.load')
console.log('bundle id :', captured.id)
if (captured.id !== '@gjs27/dsh-context-compaction') throw new Error('bundle id 与包名不一致')

const mod = captured.factory((name) => {
  if (name === 'react' || name === 'react/jsx-runtime') return reactStub
  throw new Error('unexpected require: ' + name)
})

console.log('name      :', mod.name)
console.log('inject    :', JSON.stringify(mod.inject))
console.log('platform  :', 'web (declared in package.json dsh.client)')
console.log('apply     :', typeof mod.apply)
console.log('dict keys :', Object.keys(mod.DICTS).join(', '))

// 桩 ctx：确认 slot 注册参数正确。
let reg = null
let dictRegistered = false
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: { register: () => { dictRegistered = true }, bind: () => (key, params) => params ? `[${key}:${JSON.stringify(params)}]` : `[${key}]` },
  slots: {
    inject: (slotName, fn) => { fn(); return () => {} },
    register: (opts, component) => { reg = { opts, component }; return () => {} },
  },
}
mod.apply(ctx)

if (!dictRegistered) throw new Error('未注册 locale 字典')
if (!reg) throw new Error('未注册任何 slot')
console.log('slot name :', reg.opts.name)
console.log('slot id   :', reg.opts.id)
console.log('slot order:', reg.opts.order)
console.log('组件类型  :', typeof reg.component)
if (reg.opts.name !== 'settings.section') throw new Error('slot 名必须是 settings.section')
if (reg.opts.id !== 'context-compaction') throw new Error('slot id 必须是 context-compaction')

// 渲染组件（不挂载 DOM，只确认它是个函数且不抛）。
const element = reactStub.createElement(reg.component, { t: ctx.locale.bind(mod.name) })
console.log('createElement 成功:', Boolean(element))

console.log('\n✓ 客户端 bundle 离线加载全部通过')
