# 安装 laya-gate

这个包是 [dsh-laya-mcp](https://github.com/Alexander390370/dsh-laya-mcp) 的可选配套插件：
把 Laya 的三个 MCP 工具从模型视野里隐藏，只有你输入 `/laya` 时才放开。

**前提**：你已经装好 `dsh-laya-mcp`，且模型能正常调用 `mcp__laya__laya_guard` 等工具。
本插件不包含 Laya 本体，也不下载权重。

---

## 一、解压到插件目录

把压缩包解压到一个**不会被误删的固定位置**。推荐 `~/.dsh/bundles/`：

```powershell
# Windows PowerShell
Expand-Archive -Path dsh-plugin-laya-gate-1.0.0.zip -DestinationPath "$env:USERPROFILE\.dsh\bundles\" -Force
```

```bash
# macOS / Linux
unzip dsh-plugin-laya-gate-1.0.0.zip -d ~/.dsh/bundles/
```

解压后应该有：

```
~/.dsh/bundles/laya-gate/
├── index.js
├── package.json
├── cordis.patch.yml
├── README.md
└── locale/
```

---

## 二、链接进 profile

DSH 的 profile 从 `node_modules` 解析插件。建一个链接（不要直接复制，方便以后更新）：

### Windows（需要管理员权限，或用开发者模式）

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$src = "$env:USERPROFILE\.dsh\bundles\laya-gate"
$dst = "$profileDir\node_modules\dsh-plugin-laya-gate"

New-Item -ItemType Junction -Path $dst -Target $src
```

### macOS / Linux

```bash
ln -s ~/.dsh/bundles/laya-gate ~/.dsh/profiles/desktop/node_modules/dsh-plugin-laya-gate
```

> profile 名可能不是 `desktop`。查一下 `~/.dsh/profiles/` 下有哪些目录，或看 DSH 启动时的 `DSH_PROFILE` 值。

---

## 三、登记到 profile 配置

编辑 `~/.dsh/profiles/desktop/package.json`，在**两个地方**加：

```json
{
  "dependencies": {
    "dsh-plugin-laya-gate": "link:<你的 laya-gate 绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...原有内容...",
        "dsh-plugin-laya",
        "dsh-plugin-laya-gate"
      ]
    }
  }
}
```

⚠️ 两个要点：

1. **`dependencies` 的值必须是 `link:` 开头 + 绝对路径**，Windows 用正斜杠：
   ```json
   "dsh-plugin-laya-gate": "link:C:/Users/你的用户名/.dsh/bundles/laya-gate"
   ```
2. **`bundles` 里 `dsh-plugin-laya-gate` 要排在 `dsh-plugin-laya` 之后** —— 它依赖 laya 工具已经注册。

改之前先备份：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak"
```

---

## 四、配置触发词（可选）

默认配置已经能用。要改的话编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，
**追加**（如果文件里已经是 `[]`，替换掉）：

```yaml
- insert:
    - id: laya-gate
      name: '@local/dsh-plugin-laya-gate'
      config:
        trigger: /laya      # 触发词，可改成 /ly、/决策 等
        sticky: false       # true = 触发一次后本会话永久放开
        tools:
          - mcp__laya__laya_decide
          - mcp__laya__laya_guard
          - mcp__laya__laya_status
```

---

## 五、重启 DSH

`desktop` profile 由 Electron 独占管理，**不支持热加载**。完全退出应用再启动。

重启后打开新会话，模型不应该再看到 `mcp__laya__*` 工具。输入 `/laya 测试一下`，
这一步工具就会出现。

---

## 验证

### 1. 单元测试（不依赖 DSH，随时可跑）

```powershell
$node = "C:\Users\你的用户名\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd "$env:USERPROFILE\.dsh\bundles\laya-gate"
& $node test.mjs          # 28 项
& $node test-timing.mjs   # 14 项
```

两个都显示 `全部通过` 就说明插件逻辑正常。

### 2. 行为验证

| 你做的事 | 期望结果 |
|---|---|
| 新会话里问「你能看到哪些 laya 工具」 | 模型说看不到 |
| 输入 `/laya 你好` | 这一步模型能看到三个工具 |
| 接着说「继续」（不带 `/laya`） | 工具又被收回 |

---

## 卸载

1. 从 `package.json` 里删掉 `dsh-plugin-laya-gate` 的依赖项和 bundles 条目
2. 删掉 `node_modules/dsh-plugin-laya-gate` 链接
3. 重启 DSH

或者直接用备份文件还原 `package.json`。

---

## 排查

**插件没生效，模型仍能看到 laya 工具**

- 确认 `package.json` 的 `bundles` 里两行都在，且 laya-gate 在后
- 确认 `node_modules` 里的链接指向真实目录（`Test-Path` 一下）
- 确认已完全重启应用，不是只刷新页面
- 看日志里有没有 `laya-gate:` 开头的行

**报 `unknown global tool` 错误**

工具名写错了。先确认你的 laya 工具实际叫什么 —— 在会话里问模型
「列出所有 mcp__laya__ 开头的工具」，然后改 `cordis.patch.yml` 的 `tools` 列表。

**`/laya` 不触发**

检查是否写成了 `laya`（缺斜杠）、`/layav2`、`x/laya` —— 这些都被刻意排除，防止误触发。
只有 `/laya` 这个完整词元有效。

**想临时关掉限制**

把 `cordis.patch.yml` 里的 `sticky` 改成 `true`（触发一次后本会话一直放开），
或者直接把 laya-gate 从 `bundles` 里去掉。

---

## 兼容性

- 依赖 DSH 的 `ctx.tools.restrict()` 和 `ctx.agents.currentInitiator()` 两个 API
- 在 DSH（2026-10 版本）上实测通过
- 如果未来 DSH 改了 `currentInitiator()` 语义，插件会退化成「不限制」（工具保持可见），
  不会破坏其他功能 —— 这是刻意的失败方向设计

## License

MIT，与 [dsh-laya-mcp](https://github.com/Alexander390370/dsh-laya-mcp) 一致。
