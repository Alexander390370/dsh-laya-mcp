// laya-gate 单元测试
// 通过 import map 无法 mock 真实 schemastery，所以这里用 --import loader 注入。
// 简单做法：把 index.js 的 import 行在测试时替换成 mock。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, 'index.js'), 'utf8')

// 把 schemastery import 换成 mock，写到临时文件再 import
const mockZ = `
const mk = (defaultValue) => {
  const s = { meta: { default: defaultValue } }
  s.default = (v) => { s.meta.default = v; return s }
  s.description = () => s
  s.required = () => s
  return s
}
const z = {
  string: () => mk(''),
  boolean: () => mk(false),
  number: () => mk(0),
  array: (inner) => { const s = mk([]); s._inner = inner; return s },
  object: (shape) => {
    const s = mk(undefined)
    s._shape = shape
    s['~standard'] = { vendor: 'schemastery' }
    s.simplify = (v) => v
    return s
  },
}
export default z
`

const patched = src.replace(
  /import z from '@deepseek-ai\/schemastery'/,
  "import z from './__mock_schemastery.mjs'"
)
if (patched === src) {
  console.error('FATAL: 未能替换 schemastery import')
  process.exit(1)
}

fs.writeFileSync(path.join(here, '__mock_schemastery.mjs'), mockZ)
const tmpModule = path.join(here, '__plugin_under_test.mjs')
fs.writeFileSync(tmpModule, patched)

const { apply } = await import('file:///' + tmpModule.replace(/\\/g, '/'))

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label) }
}

function makeHarness(opts = {}) {
  const handlers = new Map()
  const restrictions = []
  let currentAgent = null

  const ctx = {
    tools: {
      schemas: () => [
        { name: 'mcp__laya__laya_decide' },
        { name: 'mcp__laya__laya_guard' },
        { name: 'mcp__laya__laya_status' },
        { name: 'read' },
        { name: 'write' },
      ],
    },
    agents: { currentInitiator: () => currentAgent },
    on(e, fn) {
      if (!handlers.has(e)) handlers.set(e, [])
      handlers.get(e).push(fn)
    },
  }

  apply(ctx, {
    trigger: '/laya',
    sticky: false,
    tools: ['mcp__laya__laya_decide', 'mcp__laya__laya_guard', 'mcp__laya__laya_status'],
    ...opts,
  })

  const agent = {
    ctx: {
      tools: {
        restrict(f) {
          const rec = { filter: f, disposed: false }
          restrictions.push(rec)
          return () => { rec.disposed = true }
        },
      },
      effect: (fn) => fn(),
    },
  }

  function emit(e, p) { for (const fn of handlers.get(e) || []) fn(p) }
  emit('agent/created', { agent })
  currentAgent = agent

  function visible() {
    if (restrictions.length === 0) return true
    return restrictions[restrictions.length - 1].disposed === true
  }

  return { emit, visible, restrictions }
}

const um = (t) => ({ content: [{ type: 'text', text: t }], source: { kind: 'user' } })
const tm = (t) => ({ content: [{ type: 'text', text: t }], source: { kind: 'tool' } })

console.log('=== 1. agent 创建时默认隐藏 ===')
{
  const h = makeHarness()
  ok(h.restrictions.length === 1, 'agent/created 触发 restrict')
  const r = h.restrictions[0]
  ok(r.filter.deny.includes('mcp__laya__laya_decide'), 'deny 含 laya_decide')
  ok(r.filter.deny.includes('mcp__laya__laya_guard'), 'deny 含 laya_guard')
  ok(r.filter.deny.includes('mcp__laya__laya_status'), 'deny 含 laya_status')
  ok(!r.filter.deny.includes('read'), '不误伤 read')
  ok(!r.filter.deny.includes('write'), '不误伤 write')
}

console.log('\n=== 2. 普通输入保持隐藏 ===')
{
  const h = makeHarness()
  h.emit('agent/inbox/claimed', { message: um('帮我看看这个文档'), turn: 1 })
  ok(h.restrictions.length === 1, '没有新增 restrict')
  ok(h.visible() === false, '仍隐藏')
}

console.log('\n=== 3. /laya 放开 ===')
{
  const h = makeHarness()
  h.emit('agent/inbox/claimed', { message: um('/laya 用 guard 检查'), turn: 1 })
  ok(h.visible() === true, 'restriction 已解除')
}

console.log('\n=== 4. 多轮工具调用不被中途收回 ===')
{
  const h = makeHarness()
  h.emit('agent/inbox/claimed', { message: um('/laya 判断'), turn: 1 })
  ok(h.visible() === true, '第1步 打 /laya -> 可见')
  h.emit('agent/inbox/claimed', { message: tm('guard 结果'), turn: 1 })
  ok(h.visible() === true, '第2步 tool 结果回灌 -> 仍可见')
  h.emit('agent/inbox/claimed', { message: tm('decide 结果'), turn: 1 })
  ok(h.visible() === true, '第3步 tool 结果 -> 仍可见')
  h.emit('agent/inbox/claimed', { message: um('谢谢'), turn: 2 })
  ok(h.visible() === false, '第4步 新用户消息无 /laya -> 收回')
}

console.log('\n=== 5. 触发词边界 ===')
{
  const cases = [
    ['/laya', true], ['  /laya  ', true], ['/laya 检查', true],
    ['帮我 /laya 一下', true], ['/LAYA', true],
    ['/layav2', false], ['x/laya', false], ['/layabc', false],
    ['laya', false], ['我要用 laya 模型', false], ['/laya_decide', false],
  ]
  for (const [text, expect] of cases) {
    const h = makeHarness()
    h.emit('agent/inbox/claimed', { message: um(text), turn: 1 })
    ok(h.visible() === expect, `"${text}" -> ${expect ? '放开' : '隐藏'}`)
  }
}

console.log('\n=== 6. 非用户来源不触发 ===')
{
  const h = makeHarness()
  h.emit('agent/inbox/claimed', {
    message: { content: [{ type: 'text', text: '/laya' }], source: { kind: 'runtime-context' } },
    turn: 1,
  })
  ok(h.visible() === false, 'runtime-context 不触发放开')
}

console.log('\n=== 7. sticky 模式 ===')
{
  const h = makeHarness({ sticky: true })
  h.emit('agent/inbox/claimed', { message: um('/laya'), turn: 1 })
  ok(h.visible() === true, '触发后可见')
  h.emit('agent/inbox/claimed', { message: um('继续'), turn: 2 })
  ok(h.visible() === true, 'sticky 下新用户消息不收回')
}

console.log('\n=== 8. 工具不存在时不报错 ===')
{
  const h = makeHarness({ tools: ['mcp__nonexistent__x'] })
  let threw = false
  try { h.emit('agent/created', {}) } catch { threw = true }
  ok(!threw, '不抛错')
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  失败 ${fail}` : '  全部通过'}`)

// 清理临时文件
try { fs.unlinkSync(tmpModule) } catch {}
try { fs.unlinkSync(path.join(here, '__mock_schemastery.mjs')) } catch {}

if (fail) process.exit(1)
