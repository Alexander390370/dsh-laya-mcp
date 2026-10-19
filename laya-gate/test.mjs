// laya-gate 单元测试
// 插件零外部依赖（不 import schemastery），可直接 import 测试。
import { apply } from './index.js'

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label) }
}

function makeHarness(opts) {
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

  apply(ctx, opts === undefined ? {
    trigger: '/laya',
    sticky: false,
    tools: ['mcp__laya__laya_decide', 'mcp__laya__laya_guard', 'mcp__laya__laya_status'],
  } : opts)

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
  const h = makeHarness({ trigger: '/laya', sticky: true })
  h.emit('agent/inbox/claimed', { message: um('/laya'), turn: 1 })
  ok(h.visible() === true, '触发后放开')
  h.emit('agent/inbox/claimed', { message: um('继续'), turn: 2 })
  ok(h.visible() === true, 'sticky 下新用户消息不收回')
}

console.log('\n=== 8. 异常输入不崩溃 ===')
{
  const h = makeHarness()
  let threw = false
  try {
    h.emit('agent/created', {})
    h.emit('agent/created', null)
    h.emit('agent/inbox/claimed', {})
    h.emit('agent/inbox/claimed', null)
    h.emit('agent/inbox/claimed', { message: null })
  } catch { threw = true }
  ok(!threw, '异常 payload 不抛错')
}

console.log('\n=== 9. 不传 config 时的默认值 ===')
{
  const h = makeHarness(undefined)
  ok(h.restrictions.length === 1, '无 config 时仍默认隐藏')
  h.emit('agent/inbox/claimed', { message: um('/laya'), turn: 1 })
  ok(h.visible() === true, '无 config 时 /laya 仍能放开')
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  失败 ${fail}` : '  全部通过'}`)
if (fail) process.exit(1)
