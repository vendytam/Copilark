# Copilark

飞书群消息 × GitHub Copilot ACP 自动回复系统

## 架构

```
飞书消息
  ↓
lark-cli event +subscribe    ← 实时 WebSocket 事件订阅（NDJSON）
  ↓
lark-acp-bridge.mjs          ← 转发原始事件 JSON 给 Copilot
  ↓
copilot --acp --port 3000    ← Copilot ACP Server（大波龙 Agent）
  ↓  （Agent 自行调用 lark-im skill）
lark-cli im +messages-reply  ← 发送回复到飞书
```

**Bridge 只负责转发，回复由 Copilot Agent 通过 lark-im skill 直接发出。**

## 文件说明

| 文件 | 说明 |
|------|------|
| `launch.sh` | **一键启动**：启动时交互选择 Agent，弹出两个 Git Bash 窗口 |
| `install.sh` | **全局命令安装**：生成 `~/bin/copilark`，之后任意目录可直接运行 `copilark` |
| `start-copilot-acp.sh` | 单独启动 Copilot ACP Server（默认使用大波龙 Agent） |
| `lark-acp-bridge.mjs` | 桥接器：订阅飞书事件 → 原始 JSON 转发给 Copilot ACP |

## Agent 设定（大波龙）

Agent 文件结构：

```
~/.copilot/agents/
└── dawbolong.agent.md        ← Copilot 加载的 agent 提示词 + 经验记录（必须在根目录）

{cwd}/
└── AGENTS.md                 ← 每次启动由 launch.sh 自动从 dawbolong.agent.md 覆盖同步（Copilot 自动读取）
```

> ⚠️ Copilot CLI 只扫描 `~/.copilot/agents/*.agent.md`，**不支持子目录**。agent 文件必须放在根目录。

> ⚠️ `{cwd}/AGENTS.md` 是工作目录的本地副本，Copilot CLI 启动时自动读取作为自定义指令。每次 launch.sh 启动都会覆盖写入最新内容（包含最新经验记录）。Agent 将经验记录追加到 `~/.copilot/agents/dawbolong.agent.md` 本身，下次启动时自动同步到 AGENTS.md。

**大波龙**：飞书自动回复 AI 助手
- 权限：读写文件、执行命令、调用飞书（lark-im）、联网搜索
- 飞书消息：收到原始事件 JSON → 解析内容 → 用 lark-im 回复
- **效率原则**：闲聊/问答类消息直接回答，禁止调用 shell；只有用户明确要求操作才用工具
- **记忆机制**：解决非显而易见的问题后自动追加到 `~/.copilot/agents/dawbolong.agent.md` 末尾
- **表情回应**：每次回复前必须先对原消息添加 emoji reaction（`lark-cli im reactions create`），**根据消息内容选择合适表情**，不要固定用 THUMBSUP。常用对照：确认→`OK`/`DONE`、提问→`THINKING`、惊讶→`WOW`、开心→`JOYFUL`、报错→`SWEAT`、有趣→`LOL`
- **消息格式**：含 JSON/代码的回复必须用 `--markdown` 参数，禁止在 `--text` 双引号字符串中使用 `\"` 转义（PowerShell 会截断）；**`--markdown` 不支持 Markdown 表格**（会被丢弃），改用列表格式

修改角色：直接编辑 `~/.copilot/agents/dawbolong.agent.md`，重启 ACP Server 后生效。

项目内 `agents/dawbolong.agent.md` 是通用模板（占位符版本），可作为新机器初始化时的参考；工作目录不写在模板里，启动时交互选择或通过 `--cwd` 传入。

## 依赖

| 依赖 | 说明 |
|------|------|
| `copilot` CLI | GitHub Copilot CLI，已登录 |
| `lark-cli` | 飞书命令行工具，已通过 `lark-cli config init` 配置 |
| `node` | Node.js v18+ |
| `git-bash` | Git Bash（mintty 用于弹出新窗口） |
| `@agentclientprotocol/sdk` | ACP 客户端 SDK（已安装） |

### Windows 安装形态警告

在 Windows 上，`lark-cli` 的安装形态会直接影响 Bridge 的稳定性。

- **推荐**：官方 Node.js 安装器 + 默认全局 npm 路径
- **推荐执行入口**：
  - `lark-cli.exe`
  - 或 `node.exe <...>\@larksuite\cli\bin\lark-cli.js`
- **高风险形态**：
  - 只安装出 `lark-cli.cmd`
  - 并且运行时退回 `shell=true`

高风险形态下，Bridge 主动发送飞书消息时，中文或 emoji 参数可能被 Windows `cmd` 包装层截断。

安装 `lark-cli` 后，建议先检查：

```powershell
where lark-cli
npm root -g
Test-Path ((npm root -g) + '\@larksuite\cli\bin\lark-cli.js')
```

如果 `where lark-cli` 只返回 `.cmd`，且找不到 `lark-cli.js`，请优先修正 Node/npm 的全局安装布局，再继续配置 Copilark。

如果短期内不能调整安装布局，Bridge 也支持**显式强制入口**：

```powershell
$env:LARK_NODE_PATH="D:\Program Files\nodejs\node.exe"
$env:LARK_CLI_JS_PATH="C:\Users\<你>\AppData\Roaming\npm\node_modules\@larksuite\cli\bin\lark-cli.js"
```

或：

```powershell
$env:LARK_CLI_PATH="C:\Users\<你>\AppData\Roaming\npm\node_modules\@larksuite\cli\bin\lark-cli.exe"
```

Bridge 的优先级是：

1. `LARK_CLI_JS_PATH + LARK_NODE_PATH`
2. `LARK_CLI_PATH`
3. 自动探测

只有前两者都缺失或无效时，才会退回 `.cmd + shell=true`。

## 飞书平台配置（必须）

在 [飞书开放平台控制台](https://open.feishu.cn/) 完成：

1. **事件订阅** → 订阅方式 → 选择「使用长连接接收事件」
2. **添加事件**：`im.message.receive_v1`
3. **开通权限**：`im:message:receive_as_bot`、`im:message:send_as_bot`

## 启动方式

### 🚀 一键启动（推荐，任意目录）

安装全局命令（仅需一次）：
```bash
cd /d/Workspace/Copilark
bash install.sh
```

之后任意目录直接运行：
```bash
copilark
```

启动时会交互选择 Agent：
```
[ 选择 Agent ]
  0) 不使用 Agent（默认 Copilot）
  1) dawbolong            大波龙 — 飞书自动回复 AI 助手...

其他参数：
```bash
copilark --agent=dawbolong          # 跳过选择，直接指定
copilark --cwd='D:\Workspace\MyProject'  # 跳过工作目录选择（路径含反斜杠需加引号）
copilark --new                      # 强制创建全新会话（跳过会话选择）
copilark --continue                 # 恢复上次对话（跳过会话选择）
copilark --resume=<id>             # 恢复指定会话
copilark --model=gpt-5.4           # 指定模型
copilark --port=4000               # 自定义端口
```

> ⚠️ **路径参数注意**：Windows 路径含反斜杠时需加引号，否则 bash 会吃掉反斜杠：
> ```bash
> # ✅ 正确
> bash launch.sh --cwd='D:\your-workspace' --continue
> # ❌ 错误（反斜杠被 bash 吃掉，loadSession 会失败）
> bash launch.sh --cwd=D:\your-workspace --continue
> ```
> launch.sh 内置了自动修复逻辑，会尝试还原 `D:your-workspace` → `D:\your-workspace`，但建议还是加引号。

一键无交互启动示例：
```bash
# 全新会话
copilark --agent=dawbolong --cwd='D:\your-workspace' --new
# 恢复上次会话
copilark --agent=dawbolong --cwd='D:\your-workspace' --continue
```

看到 Bridge 窗口输出以下内容即就绪：
```
[Bridge][INFO]  [Bridge] Ready. 正在监听飞书消息...
```

启动流程（有历史会话时）：
```
[ 选择 Agent ]
  0) 不使用 Agent（默认 Copilot）
  1) dawbolong            大波龙 — 飞书自动回复 AI 助手...
  请输入编号 [0-1]: 1

[ 工作目录 ]
  默认：D:\your-workspace
  输入工作目录（直接回车使用默认）: _
  （支持退格/方向键编辑；目录不存在时自动创建）

[ 会话选择 ]
  上次会话 ID：b124c034...28c324c
  1) 恢复上次对话（--continue）（推荐）
  2) 开始全新对话
  请输入编号 [1-2]:
```

---

### 手动分步启动

```bash
# 窗口 1：ACP Server
bash start-copilot-acp.sh                          # 默认大波龙
bash start-copilot-acp.sh --agent=other --model=gpt-5.2
bash start-copilot-acp.sh --no-agent               # 不使用 Agent

# 窗口 2：Bridge
node lark-acp-bridge.mjs
```

## 控制指令

在飞书群内发送以下指令可直接控制 Bridge，**不会转发给 Copilot ACP**：

| 指令 | 说明 |
|------|------|
| `!status` | Bridge 回复最近 10 行日志（post 格式，换行正常显示） |
| `!stop` | 发送 ACP `session_cancel` 信令，立即打断当前操作（session 保持，队列清空） |



**ACP Server 窗口**：`--acp` 模式下无终端输出，窗口空白属正常。

**Bridge 窗口**是真正的监控面板，实时显示：
```
[Bridge][EVENT] 收到消息 [group] om_xxx
[Bridge][INFO]  转发原始事件给 Copilot...
  🔧 [pending] Using skill: lark-im
      输入: {...}
  ✅ [completed] tooluse_xxx
      输出: ...
你好！我是大波龙...       ← Copilot 回复流式输出
[Bridge][INFO]  Copilot 处理完成：...
```

> **ACP 两种通信模式：**
> - `--acp --port 3000`（TCP）：两个独立进程，可分别重启
> - `--acp --stdio`（stdin/stdout）：Bridge 直接 spawn Copilot 为子进程，单窗口但生命周期绑定

## 注意事项

- **单实例限制**：`lark-cli event +subscribe` 每个 App 同时只能运行一个实例
- **机器人需在群内**：机器人必须被加入目标群聊才能发送消息
- **消息队列**：Bridge 内置串行队列，按顺序处理，避免并发 ACP 请求
- **ACP 会话持久化**：Bridge 自动将 session ID 存入 `.acp-session-id`；重启时 `launch.sh` 询问是否恢复，选恢复则 Bridge 用 `loadSession` 复用旧 session，选新会话则清除文件创建新 session
- **AGENTS.md 同步**：每次 `launch.sh` 启动时，把选中的 `~/.copilot/agents/<agent>.agent.md` 覆盖写入 `{cwd}/AGENTS.md`，Copilot CLI 自动读取该文件作为自定义指令，确保 Agent 身份始终是最新版本（含最新经验记录）
- **Agent 文件位置**：`~/.copilot/agents/*.agent.md` 必须在根目录，Copilot CLI **不扫描子目录**

