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
//   * 下一步没再含 /laya：重新隐藏（sticky=false 时）。
//   * 不写 session 事件，状态从消息内容派生，重启/恢复一致。

export const name = 'dsh-plugin-laya-gate'

export const inject = ['tools', 'agents']

const DEFAULT_TOOLS = [
  'mcp__laya__laya_decide',
  'mcp__laya__laya_guard',
  'mcp__laya__laya_status',
]

const DEFAULT_TRIGGER = '/laya'

export const Config = (Schema) =>
  Schema.object({
    trigger: Schema.string().default(DEFAULT_TRIGGER)
      .description('用户输入中出现该词元时，本步放开 laya 工具'),
    sticky: Schema.boolean().default(false)
      .description('true = 触发一次后本会话持续放开；false = 仅当步有效'),
    tools: Schema.array(Schema.string()).default(DEFAULT_TOOLS)
      .description('受管的工具名列表'),
  })

/** 从 UserMessage 提取纯文本。结构：{ content: [{ type:'text', text }] } */
function textOf(message) {
  if (!message || typeof message !== 'object') return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const parts = []
    for (const block of c) {
      if (!block || typeof block !== 'object') continue
      if (typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
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
  if (!text || !trigger) return false
  const t = trigger.trim()
  if (!t) return false
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\w/])${esc}(?![\\w])`, 'i')
  return re.test(text)
}

export function apply(ctx, config) {
  const cfg = config || {}
  const trigger = cfg.trigger || DEFAULT_TRIGGER
  const sticky = cfg.sticky === true
  const tools = Array.isArray(cfg.tools) && cfg.tools.length ? cfg.tools : DEFAULT_TOOLS

  // agent -> { deny: disposer|null, revealed: bool, disabled: bool }
  const state = new Map()

  /**
   * 全局（不受任何 restriction 影响的）工具名集合。
   * 必须用无 scope 的全局视图：schemas(agent.ctx) 返回的是"已受限后"的列表，
   * 拿它做过滤会在第二次 hide 时把目标全滤掉。
   * restrict() 的 known 校验本身用 restrictableNames（也是全局的），所以
   * 即便工具当前对模型不可见，按名字 deny 依然合法。
   */
  function globalNames() {
    try {
      const set = new Set()
      for (const s of ctx.tools.schemas()) set.add(s.name)
      return set
    } catch {
      return null
    }
  }

  function hide(agent) {
    const st = state.get(agent)
    if (!st || st.deny || st.disabled) return
    const names = globalNames()
    const targets = names ? tools.filter((n) => names.has(n)) : tools
    if (targets.length === 0) {
      // 全局视图里都没有：laya 未安装，永久跳过，避免每步重试
      st.disabled = true
      return
    }
    try {
      st.deny = agent.ctx.tools.restrict({ deny: targets })
    } catch (err) {
      st.disabled = true
      ctx.logger?.warn?.(`laya-gate: restrict 失败，laya 工具保持可见：${err && err.message}`)
    }
  }

  function show(agent) {
    const st = state.get(agent)
    if (!st || !st.deny) return
    try {
      st.deny()
    } catch {
      // dispose 失败不影响后续
    }
    st.deny = null
  }

  function ensure(agent) {
    let st = state.get(agent)
    if (!st) {
      st = { deny: null, granted: false, revealed: false, disabled: false }
      state.set(agent, st)
      hide(agent)
    }
    return st
  }

  // ---- agent 创建：立即隐藏（首步之前就生效）----
  ctx.on('agent/created', (agent) => {
    ensure(agent)
    const dispose = agent.ctx.effect(() => () => {
      const st = state.get(agent)
      if (st && st.deny) {
        try { st.deny() } catch { /* ignore */ }
      }
      state.delete(agent)
    })
    ctx.effect(() => dispose)
  })

  // ---- 消息被认领：assemble() 之前切换可见性 ----
  //
  // 语义要点：用户打 /laya 后，laya 工具必须在"这一轮任务"内保持可见，
  // 不能因为下一步是 tool 结果回灌就收回 —— 否则模型看到工具却调不了，
  // 多轮工具使用直接断掉。
  //
  // 所以只在"新的用户输入"到达时重新判定：
  //   * 用户输入含 /laya      -> 放开，标记本轮已授权
  //   * 用户输入不含 /laya    -> 若本轮未授权则保持隐藏；授权过则结束授权、重新隐藏
  //   * 非用户输入（tool 结果、runtime-context、assistant 回灌）-> 完全不干预
  ctx.on('agent/inbox/claimed', (payload) => {
    const agent = ctx.agents.currentInitiator()
    if (!agent) return
    const message = payload?.message
    if (!message) return

    const st = ensure(agent)
    if (st.disabled) return

    // 只看真实用户输入；其它来源一律不改变可见性
    const kind = message.source && message.source.kind
    if (kind !== undefined && kind !== 'user') return

    const text = textOf(message)
    if (!text) return

    if (hasTrigger(text, trigger)) {
      show(agent)
      st.granted = true
      if (sticky) st.revealed = true
      ctx.logger?.info?.(`laya-gate: 检测到 ${trigger}，本轮放开 laya 工具`)
    } else if (!sticky) {
      // 新的一轮用户输入且未带 /laya：结束上一轮授权
      if (st.granted) {
        st.granted = false
        hide(agent)
      }
    }
  })
}

// cordis 插件既接受具名导出，也接受 default 对象；两种都提供最稳妥。
export default { name, inject, apply, Config }

