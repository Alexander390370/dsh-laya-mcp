// laya-gate 逻辑单元测试（不依赖 DSH 运行时，用 mock 验证核心行为）
import { apply } from './index.js'

let pass = 0
let fail = 0

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}`)
  }
}

// ---------- mock DSH ----------
function makeHarness(opts = {}) {
  const handlers = new Map()
  const restrictions = []       // 记录每次 restrict 调用
  const logs = []
  let currentAgent = null

  const toolsService = {
    schemas(scope) {
      // 无 scope = 全局；模拟真实行为：全局总是全部可见
      return [
        { name: 'mcp__laya__laya_decide' },
        { name: 'mcp__laya__laya_guard' },
        { name: 'mcp__laya__laya_status' },
        { name: 'read' },
        { name: 'write' },
      ]
    },
  }

  const agentsService = {
    currentInitiator() { return currentAgent },
  }

  function makeAgent(id) {
    const ctx = {
      tools: {
        restrict(filter) {
          const rec = { agent: id, filter, disposed: false }
          restrictions.push(rec)
          return () => { rec.disposed = true }
        },
      },
      effect(fn) {
        const disposer = fn()
        return disposer
      },
    }
    return { id, ctx }
  }

  const ctx = {
    tools: toolsService,
    agents: agentsService,
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, [])
      handlers.get(evt).push(fn)
    },
    effect(fn) { return fn() },
  }

  const config = { trigger: '/laya', sticky: false, tools: [
    'mcp__laya__laya_decide', 'mcp__laya__laya_guard', 'mcp__laya__laya_status',
  ], ...opts }

  apply(ctx, config)

  function emit(evt, payload) {
    for (const fn of handlers.get(evt) || []) fn(payload)
  }

  return {
    ctx, makeAgent, emit, restrictions, logs,
    setCurrent(a) { currentAgent = a },
    handlers,
  }
}

function userMsg(text) {
  return { content: [{ type: 'text', text }], source: { kind: 'user' } }
}

console.log('=== 1. agent 创建时默认隐藏 ===')
{
  const h = makeHarness()
  const agent = h.makeAgent('a1')
  h.emit('agent/created', agent)
  ok(h.restrictions.length === 1, 'agent/created 触发一次 restrict')
  const r = h.restrictions[0]
  ok(r.filter.deny.includes('mcp__laya__laya_decide'), 'deny 含 laya_decide')
  ok(r.filter.deny.includes('mcp__laya__laya_guard'), 'deny 含 laya_guard')
  ok(r.filter.deny.includes('mcp__laya__laya_status'), 'deny 含 laya_status')
  ok(!r.filter.deny.includes('read'), '不误伤 read')
  ok(!r.filter.deny.includes('write'), '不误伤 write')
}

console.log('\n=== 2. 普通输入：保持隐藏 ===')
{
  const h = makeHarness()
  const agent = h.makeAgent('a2')
  h.emit('agent/created', agent)
  h.setCurrent(agent)
  h.emit('agent/inbox/claimed', { message: userMsg('帮我看看这个文档'), turn: 1 })
  ok(h.restrictions.length === 1, '没有新增 restrict（仍隐藏）')
  ok(h.restrictions[0].disposed === false, 'restriction 未解除')
}

console.log('\n=== 3. 输入 /laya：放开 ===')
{
  const h = makeHarness()
  const agent = h.makeAgent('a3')
  h.emit('agent/created', agent)
  h.setCurrent(agent)
  h.emit('agent/inbox/claimed', { message: userMsg('/laya 用 guard 检查这段文字'), turn: 1 })
  ok(h.restrictions[0].disposed === true, 'restriction 已解除')
  ok(h.logs.some(([lvl, m]) => lvl === 'info' && m.includes('/laya')), '记录了放开日志')
}

console.log('\n=== 4. 下一步无 /laya：重新隐藏 ===')
{
  const h = makeHarness()
  const agent = h.makeAgent('a4')
  h.emit('agent/created', agent)
  h.setCurrent(agent)
  h.emit('agent/inbox/claimed', { message: userMsg('/laya 检查一下'), turn: 1 })
  ok(h.restrictions[0].disposed === true, '第一步已放开')
  h.emit('agent/inbox/claimed', { message: userMsg('好的继续'), turn: 2 })
  ok(h.restrictions.length === 2, '第二步重新 hide（新增 restrict）')
  ok(h.restrictions[1].disposed === false, '第二步处于隐藏')
}

console.log('\n=== 5. 触发词边界 ===')
{
  const cases = [
    ['/laya', true],
    ['  /laya  ', true],
    ['/laya 检查', true],
    ['帮我 /laya 一下', true],
    ['/LAYA', true],
    ['/layav2', false],
    ['x/laya', false],
    ['/layabc', false],
    ['laya', false],            // 无斜杠不算
    ['我要用 laya 模型', false], // 无斜杠不算
    ['/laya_decide', false],
  ]
  for (const [text, expect] of cases) {
    const h = makeHarness()
    const agent = h.makeAgent('t')
    h.emit('agent/created', agent)
    h.setCurrent(agent)
    h.emit('agent/inbox/claimed', { message: userMsg(text), turn: 1 })
    const triggered = h.restrictions[0].disposed === true
    ok(triggered === expect, `"${text}" -> ${triggered ? '放开' : '隐藏'}（期望 ${expect ? '放开' : '隐藏'}）`)
  }
}

console.log('\n=== 6. 非用户来源的消息不触发 ===')
{
  const h = makeHarness()
  const agent = h.makeAgent('a6')
  h.emit('agent/created', agent)
  h.setCurrent(agent)
  h.emit('agent/inbox/claimed', {
    message: { content: [{ type: 'text', text: '/laya' }], source: { kind: 'runtime-context' } },
    turn: 1,
  })
  ok(h.restrictions[0].disposed === false, 'runtime-context 不触发放开')
}

console.log('\n=== 7. sticky 模式 ===')
{
  const h = makeHarness({ sticky: true })
  const agent = h.makeAgent('a7')
  h.emit('agent/created', agent)
  h.setCurrent(agent)
  h.emit('agent/inbox/claimed', { message: userMsg('/laya'), turn: 1 })
  ok(h.restrictions[0].disposed === true, '触发后放开')
  h.emit('agent/inbox/claimed', { message: userMsg('继续'), turn: 2 })
  ok(h.restrictions.length === 1, 'sticky 模式下不重新 hide')
}

console.log('\n=== 8. 没有 laya 工具时不报错 ===')
{
  const h = makeHarness({ tools: ['mcp__nonexistent__x'] })
  const agent = h.makeAgent('a8')
  let threw = false
  try { h.emit('agent/created', agent) } catch { threw = true }
  ok(!threw, '目标工具不存在时不抛错')
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  ❌ 失败 ${fail}` : '  ✅ 全部通过'}`)
if (fail) process.exit(1)
