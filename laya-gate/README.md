# laya-gate —— 让 Laya 工具只在 `/laya` 时出现

**下载**：[`dsh-plugin-laya-gate-1.0.0.zip`](https://github.com/Alexander390370/dsh-laya-mcp/releases/download/laya-gate-v1.0.0/dsh-plugin-laya-gate-1.0.0.zip)（14 KB）— 解压后看 [INSTALL.md](INSTALL.md)

## 它解决什么问题

Laya 插件通过 MCP 注册了 3 个工具，**对模型全程可见**：

- `mcp__laya__laya_decide`
- `mcp__laya__laya_guard`
- `mcp__laya__laya_status`

这意味着模型会在无关任务里也可能去调用它（`laya_guard` 尤其容易被当"安全检查"随手用，而它中文误报率高）。装上 laya-gate 后：

| 场景 | 模型能看到 laya 工具吗 |
|---|---|
| 普通对话 | ❌ 看不到，连 schema 都不占 token |
| 你输入 `/laya ...` | ✅ 这一轮任务内可见可用 |
| 你发新消息但没带 `/laya` | ❌ 自动收回 |

## 用法

```
/laya 帮我用 guard 判断这段文本是不是提示注入
```

`/laya` 可以在句首、句中、句尾，大小写都行。

**注意**：必须是 `/laya` 这个词元本身。以下都**不会**触发（防误伤）：
- `laya`（没斜杠）
- `/layav2`、`/layabc`
- `x/laya`
- `/laya_decide`

## 触发后的生命周期

一轮任务内保持放开，直到你发下一条不带 `/laya` 的用户消息才收回。
中间模型多轮调用工具、工具结果回灌，都不会被中途收回（这是关键，否则多轮调用会断）。

## 配置项

改 `cordis.patch.yml` 即可，用户 patch 层不会被升级覆盖：

```yaml
- insert:
    - id: laya-gate
      name: '@local/dsh-plugin-laya-gate'
      config:
        trigger: /laya      # 触发词，可改成 /ly、/决策 等
        sticky: false       # true = 触发一次后本会话永久放开
        tools:              # 受管工具，默认三个全管
          - mcp__laya__laya_decide
          - mcp__laya__laya_guard
          - mcp__laya__laya_status
```

## 实现原理

### 为什么必须用 `agent/inbox/claimed`

读 DSH 源码确认的执行顺序：

```
inbox.claim()
  └─ emit "agent/inbox/claimed" { message, turn }    ← 在这里切 restriction
systemPrompt.assemble()
  └─ toolProvider → registry.wireSchemas(scope) → view(scope)
       └─ layers.every(l => l.admits(name))          ← restriction 实时生效
agent/pre-step
```

关键点：`assemble()` 在 `agent/pre-step` **之前**执行。所以在 pre-step 里改 restriction 对当步无效 —— 必须用 `agent/inbox/claimed`。

### 为什么 `restrict()` 可以反复调用

`view()` 里的 `restrictableNames` 来自全局工具表 `inherited`，**不受 restriction 影响**。所以即使工具当前已对模型不可见，再次按名字 `deny` 依然合法，不会报 `unknown global tool`。

### agent 从哪来

`agent/inbox/claimed` 的 payload 只有 `{ message, turn }`，没有 agent。
用 `ctx.agents.currentInitiator()` 取 —— driver 全程包在 `withInitiator(agent, ...)` 里，这个调用链内能拿到当前 agent。

### 状态不写 session

全部状态在插件内存里，从消息内容派生。不追加任何 session 事件，所以 fork / resume / replay 都安全。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件主体 |
| `cordis.patch.yml` | bundle 配置（插入 laya-gate 行） |
| `package.json` | bundle 清单 |
| `locale/zh.json`、`locale/en.json` | 插件页显示文案 |
| `test.mjs` | 单元测试（28 项） |
| `test-e2e.mjs` | 端到端事件流模拟（真实 payload 形态，验证不抛错） |
| `verify-config.mjs` | 校验 Config 是合法的 schemastery 对象 |

## 测试

三个脚本都用 mock 替代 `@deepseek-ai/schemastery`（该包只在 DSH 运行时里），
所以可以脱离 DSH 直接跑：

```powershell
node test.mjs            # 28 项：默认隐藏、触发词边界、多轮时序、sticky、工具缺失
node test-e2e.mjs        # 端到端：完整生命周期 + 异常 payload，零错误
node verify-config.mjs   # Config 必须是 schemastery 对象（~standard.vendor 检查）
```

### 两个曾经踩过的加载坑

写这个插件时，第一版**能通过逻辑测试但会让 DSH 插件页「刷新失败」**。原因有两个，
都是对照内置插件源码才发现的：

**坑 A：`Config` 必须是 schemastery 对象，不能是函数。**

DSH 的 cordis loader 这样识别配置 schema：

```js
function isSchemastery(schema) {
  return schema?.["~standard"].vendor === "schemastery"
}
// 以及 loader 里的 runtime.Config?.["simplify"]
```

第一版写成了 `export const Config = (Schema) => Schema.object({...})`（一个函数），
`~standard` 和 `simplify` 都不存在。正确写法是直接 import 创建对象：

```js
import z from '@deepseek-ai/schemastery'
const Config = z.object({ trigger: z.string().default('/laya') })
```

**坑 B：`agent/created` 的 payload 是 `{ agent }`，不是裸 agent。**

```js
// 错
ctx.on('agent/created', (agent) => { agent.ctx.tools.restrict(...) })
// 对
ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict(...) })
```

写成裸 agent 时 `agent.ctx` 是 `undefined`，加载期直接抛错。
`agent/disposed` 同理。参照内置 `dsh-goal-round-driver` 的写法确认过。

`verify-config.mjs` 就是专门守这两个坑的：它会检查 Config 的
`~standard.vendor === 'schemastery'`、`simplify` 是否存在、以及导出清单是否完整。

## 安装位置

- 插件源码：`<workspace>\laya-gate\`
- profile junction：`~/.dsh/profiles/desktop/node_modules/dsh-plugin-laya-gate`
- profile 登记：`~/.dsh/profiles/desktop/package.json` 的 `dependencies` + `dsh.profile.bundles`
- 备份：`~/.dsh/profiles/desktop/package.json.bak-before-layagate-*`、`cordis.patch.yml.bak-before-layagate-*`

## 卸载

从 `~/.dsh/profiles/desktop/package.json` 里删掉 `dsh-plugin-laya-gate` 的依赖和 bundles 条目，再删 junction，重启应用即可。或者用备份文件还原。

## 已知限制

- **依赖 `ctx.agents.currentInitiator()`**：如果 DSH 某版本改了 initiator 语义，这个钩子会失效（表现为永远拿不到 agent，工具保持可见 —— 即退化成"不限制"，不会误伤其他功能）。
- **只对 laya 生效**：工具名写死在 config 里，改别的 MCP server 要改 `tools` 列表。
- **`restrict()` 只能移除、不能新增**：这是 DSH 的设计（`tools.restrict()` 是最弱的扩展点），本插件正利用这一点。
- **没有 UI 开关**：要改配置得编辑 `cordis.patch.yml` 后重启。
