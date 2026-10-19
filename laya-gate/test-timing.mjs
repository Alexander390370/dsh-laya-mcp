// 多轮时序测试（修正版）：
// 关键断言是"restriction 是否仍处于解除状态"，而不是"有没有新增 restrict"。
import { apply } from './index.js'

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
      ],
    },
    agents: { currentInitiator: () => currentAgent },
    logger: { info: () => {}, warn: () => {} },
    on(e, fn) {
      if (!handlers.has(e)) handlers.set(e, [])
      handlers.get(e).push(fn)
    },
    effect: (fn) => fn(),
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
  emit('agent/created', agent)
  currentAgent = agent

  // 当前是否对模型可见：所有已发出的 restriction 里，最新一条若未 disposed 则隐藏
  function visible() {
    if (restrictions.length === 0) return true
    return restrictions[restrictions.length - 1].disposed === true
  }

  return { emit, visible, restrictions }
}

const um = (t) => ({ content: [{ type: 'text', text: t }], source: { kind: 'user' } })
const tm = (t) => ({ content: [{ type: 'text', text: t }], source: { kind: 'tool' } })

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

console.log('=== 场景 A：用户打 /laya 后多轮工具调用 ===')
{
  const h = makeHarness()
  ok(h.visible() === false, '初始：隐藏')

  h.emit('agent/inbox/claimed', { message: um('/laya 判断一下这段文本'), turn: 1 })
  ok(h.visible() === true, '第1步 用户打 /laya -> 可见')

  h.emit('agent/inbox/claimed', { message: tm('guard 返回 {score:0.1}'), turn: 1 })
  ok(h.visible() === true, '第2步 tool 结果回灌 -> 仍可见（关键修复）')

  h.emit('agent/inbox/claimed', { message: tm('decide 返回 ok'), turn: 1 })
  ok(h.visible() === true, '第3步 再次 tool 结果 -> 仍可见')

  h.emit('agent/inbox/claimed', { message: um('好的，谢谢'), turn: 2 })
  ok(h.visible() === false, '第4步 新用户消息不含 /laya -> 收回')
}

console.log('\n=== 场景 B：连续两轮都用 /laya ===')
{
  const h = makeHarness()
  h.emit('agent/inbox/claimed', { message: um('/laya 第一次'), turn: 1 })
  ok(h.visible() === true, '第1轮可见')
  h.emit('agent/inbox/claimed', { message: um('/laya 第二次'), turn: 2 })
  ok(h.visible() === true, '第2轮仍可见')
}

console.log('\n=== 场景 C：从未用 /laya，全程隐藏 ===')
{
  const h = makeHarness()
  ok(h.visible() === false, '初始隐藏')
  h.emit('agent/inbox/claimed', { message: um('帮我写个函数'), turn: 1 })
  ok(h.visible() === false, '普通输入后仍隐藏')
  h.emit('agent/inbox/claimed', { message: tm('结果'), turn: 1 })
  ok(h.visible() === false, 'tool 回灌后仍隐藏')
}

console.log('\n=== 场景 D：sticky=true 一次授权永久有效 ===')
{
  const h = makeHarness({ sticky: true })
  h.emit('agent/inbox/claimed', { message: um('/laya'), turn: 1 })
  ok(h.visible() === true, '触发后可见')
  h.emit('agent/inbox/claimed', { message: um('普通消息'), turn: 2 })
  ok(h.visible() === true, 'sticky 下新用户消息不收回')
}

console.log('\n=== 场景 E：runtime-context 注入不干扰 ===')
{
  const h = makeHarness()
  h.emit('agent/inbox/claimed', { message: um('/laya'), turn: 1 })
  ok(h.visible() === true, '触发后可见')
  h.emit('agent/inbox/claimed', {
    message: { content: [{ type: 'text', text: '工作目录信息' }], source: { kind: 'runtime-context' } },
    turn: 1,
  })
  ok(h.visible() === true, 'runtime-context 不触发放回')
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  ❌ 失败 ${fail}` : '  ✅ 全部通过'}`)
if (fail) process.exit(1)
