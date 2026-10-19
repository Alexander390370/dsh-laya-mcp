// @local/dsh-plugin-laya-gate
//
// 把 laya 的 MCP 工具从模型视野里隐藏，只有用户在输入里打 /laya 时才放开。
//
// 时序依据（读 dsh-agent-loop / dsh-system-prompt / dsh-tools 源码确认）：
//   inbox.claim()
//     └─ emit "agent/inbox/claimed"  { message, turn }   <- 在这里切 restriction
//   systemPrompt.assemble()                                <- 收集工具 schema
//        └─ toolProvider → registry.wireSchemas(scope) → view(scope)
//            └─ layers.every(l => l.admits(name))        <- restriction 实时生效
//   agent/pre-step
//
// 所以切换必须发生在 assemble() 之前 —— agent/inbox/claimed 是唯一合适的钩子，
// 它在 claim() 内部同步派发，而 claim() 在 assemble() 之前。
//
// agent 从 ctx.agents.currentInitiator() 取（driver 全程包在 withInitiator 里）。
//
// 行为：
//   * 默认：restrict({ deny }) → 三个 laya 工具不进模型 tool schema，不占 token。
//   * 本步消息含 /laya：解除 restriction，本步可见可用。
//   * 下一轮用户消息没再含 /laya：重新隐藏（sticky=false 时）。
//   * 不写 session 事件，状态从消息内容派生，重启/恢复一致。

import z from '@deepseek-ai/schemastery'

/** Stable Loader identity. */
const name = 'dsh-plugin-laya-gate'

/** Services used by this plugin. */
const inject = ['tools', 'agents']

/**
 * 配置 schema。必须是 schemastery 对象 —— DSH 的 cordis loader 通过
 * Config["~standard"].vendor === "schemastery" 与 Config.simplify 识别它；
 * 导出函数会让插件加载失败（表现为插件页「刷新失败」）。
 */
const Config = z.object({
  trigger: z.string().default('/laya'),
  sticky: z.boolean().default(false),
  tools: z.array(z.string()).default([
    'mcp__laya__laya_decide',
    'mcp__laya__laya_guard',
    'mcp__laya__laya_status',
  ]),
})

/** 从 UserMessage 提取纯文本。结构：{ content: [{ type:'text', text }] } */
function textOf(message) {
  if (message === undefined || message === null) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    let out = ''
    for (const block of c) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') {
        if (out.length > 0) out += '\n'
        out += block.text
      }
    }
    return out
  }
  if (typeof message.text === 'string') return message.text
  return ''
}

/**
 * 词元边界匹配 /laya。
 * 前导斜杠必须有；前后不能紧邻字母/数字（前导额外排除斜杠），
 * 避免 /layav2、x/laya、/layabc 误触发。
 */
function hasTrigger(text, trigger) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (typeof trigger !== 'string') return false
  const t = trigger.trim()
  if (t.length === 0) return false
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re
  try {
    re = new RegExp('(?<![\\w/])' + esc + '(?![\\w])', 'i')
  } catch {
    // 老引擎不支持后行断言时退化为朴素包含判断
    return text.indexOf(t) !== -1
  }
  return re.test(text)
}

function apply(ctx, config) {
  const cfg = config || {}
  const trigger = typeof cfg.trigger === 'string' ? cfg.trigger : '/laya'
  const sticky = cfg.sticky === true
  const tools = Array.isArray(cfg.tools) && cfg.tools.length > 0
    ? cfg.tools
    : ['mcp__laya__laya_decide', 'mcp__laya__laya_guard', 'mcp__laya__laya_status']

  // agent -> { deny: disposer|null, granted: bool, revealed: bool, disabled: bool }
  const state = new Map()

  /** 全局（不受 restriction 影响的）工具名集合；失败返回 undefined */
  function globalNames() {
    try {
      const set = new Set()
      for (const s of ctx.tools.schemas()) set.add(s.name)
      return set
    } catch {
      return undefined
    }
  }

  function hide(agent) {
    const st = state.get(agent)
    if (st === undefined || st.deny !== null || st.disabled) return
    const names = globalNames()
    const targets = names === undefined ? tools : tools.filter((n) => names.has(n))
    if (targets.length === 0) {
      // 全局视图里都没有：laya 未安装，永久跳过，避免每步重试
      st.disabled = true
      return
    }
    try {
      st.deny = agent.ctx.tools.restrict({ deny: targets })
    } catch {
      // 工具名不存在 / 已被别的插件遮蔽：保持可见，不再重试
      st.disabled = true
    }
  }

  function show(agent) {
    const st = state.get(agent)
    if (st === undefined || st.deny === null) return
    try {
      st.deny()
    } catch {
      // dispose 失败不影响后续
    }
    st.deny = null
  }

  function ensure(agent) {
    let st = state.get(agent)
    if (st === undefined) {
      st = { deny: null, granted: false, revealed: false, disabled: false }
      state.set(agent, st)
      hide(agent)
    }
    return st
  }

  // ---- agent 创建：立即隐藏（首步之前就生效）----
  // 注意：payload 是 { agent }，不是裸 agent。
  ctx.on('agent/created', (payload) => {
    const agent = payload !== undefined && payload !== null ? payload.agent : undefined
    if (agent === undefined || agent === null || agent.ctx === undefined) return
    ensure(agent)
    // 注册在 agent.ctx 上：agent 销毁时自动清理 restriction 与状态
    try {
      agent.ctx.effect(() => () => {
        const st = state.get(agent)
        if (st !== undefined && st.deny !== null) {
          try { st.deny() } catch { /* ignore */ }
        }
        state.delete(agent)
      })
    } catch {
      // effect 不可用时不阻断加载；状态仍会在 agent/disposed 时清理
    }
  })

  // 兜底清理（防止 effect 注册失败时状态泄漏）
  ctx.on('agent/disposed', (payload) => {
    const agent = payload !== undefined && payload !== null ? payload.agent : undefined
    if (agent === undefined || agent === null) return
    const st = state.get(agent)
    if (st !== undefined && st.deny !== null) {
      try { st.deny() } catch { /* ignore */ }
    }
    state.delete(agent)
  })

  // ---- 消息被认领：assemble() 之前切换可见性 ----
  //
  // 语义要点：用户打 /laya 后，laya 工具必须在"这一轮任务"内保持可见，
  // 不能因为下一步是 tool 结果回灌就收回 —— 否则模型看到工具却调不了，
  // 多轮工具使用直接断掉。
  //
  // 所以只在"新的用户输入"到达时重新判定：
  //   * 用户输入含 /laya      -> 放开，标记本轮已授权
  //   * 用户输入不含 /laya    -> 若本轮授权过则结束授权、重新隐藏
  //   * 非用户输入（tool 结果、runtime-context 等）-> 完全不干预
  ctx.on('agent/inbox/claimed', (payload) => {
    if (payload === undefined || payload === null) return
    let agent
    try {
      agent = ctx.agents.currentInitiator()
    } catch {
      return
    }
    if (agent === undefined || agent === null) return
    const message = payload.message
    if (message === undefined || message === null) return

    const st = ensure(agent)
    if (st.disabled) return

    // 只看真实用户输入；其它来源一律不改变可见性
    const source = message.source
    const kind = source !== undefined && source !== null ? source.kind : undefined
    if (kind !== undefined && kind !== 'user') return

    const text = textOf(message)
    if (text.length === 0) return

    if (hasTrigger(text, trigger)) {
      show(agent)
      st.granted = true
      if (sticky) st.revealed = true
    } else if (!sticky && st.granted) {
      // 新的一轮用户输入且未带 /laya：结束上一轮授权
      st.granted = false
      hide(agent)
    }
  })
}

export { Config, apply, inject, name }
export default { name, inject, apply, Config }
