// 端到端模拟：用真实 payload 形态跑完整事件流，确认不抛任何错误
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, 'index.js'), 'utf8')

const mockZ = `const mk = (dv) => {
  const s = { meta: { default: dv } }
  s.default = (v) => { s.meta.default = v; return s }
  s.description = () => s
  s.required = () => s
  return s
}
const z = {
  string: () => mk(''),
  boolean: () => mk(false),
  number: () => mk(0),
  array: (i) => { const s = mk([]); s._inner = i; return s },
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
fs.writeFileSync(path.join(here, '__ez.mjs'), mockZ)
const patched = src.replace(/import z from '@deepseek-ai\/schemastery'/, "import z from './__ez.mjs'")
fs.writeFileSync(path.join(here, '__ep.mjs'), patched)
const plugin = await import('file:///' + path.join(here, '__ep.mjs').replace(/\\/g, '/'))

let errors = []
const handlers = new Map()
const restrictions = []
const agents = []
let currentAgent = null

const ctx = {
  tools: {
    schemas: () => [
      { name: 'mcp__laya__laya_decide' },
      { name: 'mcp__laya__laya_guard' },
      { name: 'mcp__laya__laya_status' },
      { name: 'read' },
    ],
  },
  agents: { currentInitiator: () => currentAgent },
  on(e, fn) {
    if (!handlers.has(e)) handlers.set(e, [])
    handlers.get(e).push(fn)
  },
}

function makeAgent(id) {
  const a = {
    id,
    ctx: {
      tools: {
        restrict(f) {
          const rec = { agent: id, filter: f, disposed: false }
          restrictions.push(rec)
          return () => { rec.disposed = true }
        },
      },
      effect: (fn) => { const d = fn(); return d },
    },
  }
  agents.push(a)
  return a
}

function emit(e, payload) {
  for (const fn of handlers.get(e) || []) {
    try { fn(payload) } catch (err) { errors.push(`${e}: ${err.message}`) }
  }
}

// 加载插件
try {
  plugin.apply(ctx, { trigger: '/laya', sticky: false, tools: [
    'mcp__laya__laya_decide', 'mcp__laya__laya_guard', 'mcp__laya__laya_status',
  ] })
  console.log('插件 apply 成功')
} catch (err) {
  console.log('插件 apply 失败:', err.message)
  process.exit(1)
}

// 模拟完整生命周期
const a1 = makeAgent('agent-1')
emit('agent/created', { agent: a1 })
currentAgent = a1

emit('agent/inbox/claimed', {
  message: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } },
  turn: 1,
})

emit('agent/inbox/claimed', {
  message: { content: [{ type: 'text', text: '/laya 检查' }], source: { kind: 'user' } },
  turn: 2,
})

emit('agent/inbox/claimed', {
  message: { content: [{ type: 'text', text: 'tool result' }], source: { kind: 'tool' } },
  turn: 2,
})

// 第二个 agent
const a2 = makeAgent('agent-2')
emit('agent/created', { agent: a2 })
currentAgent = a2
emit('agent/inbox/claimed', {
  message: { content: [{ type: 'text', text: '/laya' }], source: { kind: 'user' } },
  turn: 1,
})

// 销毁
emit('agent/disposed', { agent: a1 })
emit('agent/disposed', { agent: a2 })

// 异常 payload 测试
emit('agent/created', {})
emit('agent/created', null)
emit('agent/inbox/claimed', {})
emit('agent/inbox/claimed', null)
emit('agent/inbox/claimed', { message: null })

console.log('\n=== 结果 ===')
console.log('  restriction 调用次数:', restrictions.length)
console.log('  错误数:', errors.length)
if (errors.length) {
  for (const e of errors) console.log('    ERR:', e)
  process.exit(1)
} else {
  console.log('  无错误')
}

try { fs.unlinkSync(path.join(here, '__ez.mjs')) } catch {}
try { fs.unlinkSync(path.join(here, '__ep.mjs')) } catch {}
