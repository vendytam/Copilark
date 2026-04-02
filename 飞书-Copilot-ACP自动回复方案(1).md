# 飞书消息 × Copilot ACP 自动回复方案

## 概述

通过 GitHub Copilot CLI 的 ACP（Agent Client Protocol）协议，将飞书群消息接入一个持久的 Copilot AI 会话，实现智能自动回复。

```
飞书消息
  ↓
lark-cli event +subscribe    ← 实时事件订阅
  ↓
lark-acp-bridge.mjs          ← 转发原始事件 JSON
  ↓
copilot --acp --port 3000    ← Copilot ACP Server（大波龙 Agent）
  ↓  （Agent 自行调用 lark-im skill）
lark-cli im +messages-reply  ← 发送回复到飞书
```

**Bridge 只负责转发原始飞书事件 JSON，回复由 Copilot Agent 通过 lark-im skill 直接发出。**

项目目录：`D:\Workspace\LarkCli2Copilot`

---

## 核心概念

### ACP 是什么

ACP（Agent Client Protocol）是 GitHub Copilot CLI 提供的服务端模式，允许外部程序通过标准协议与 Copilot AI 通信。

```bash
# stdio 模式（Bridge spawn Copilot 为子进程，单窗口）
copilot --acp --stdio

# TCP 模式（两个独立进程，本项目使用此方式）
copilot --acp --port 3000
```

**TCP vs stdio 对比：**

| | TCP 模式 | stdio 模式 |
|---|---|---|
| 进程数 | 2个独立窗口 | 1个窗口（Bridge 包含 Copilot） |
| 重启 | 可单独重启 ACP | Copilot 跟 Bridge 一起重启 |
| ACP 窗口输出 | 空白（`--acp` 模式无终端输出） | 无独立窗口 |

> **注意**：`--acp` 模式下 ACP Server 窗口空白属正常，所有工作过程通过 TCP 协议流给 Bridge，在 **Bridge 窗口**可视化显示。

文档：https://docs.github.com/zh/copilot/reference/copilot-cli-reference/acp-server

### ACP vs 普通 Copilot CLI

| | 普通 Copilot CLI | ACP Server |
|---|---|---|
| 输入来源 | 终端键盘输入 | 程序通过协议发送 |
| 输出去向 | 终端显示 | 程序接收并处理 |
| 权限确认 | 用户手动确认 | `requestPermission` 回调自动处理 |
| 模型能力 | 完全相同 | 完全相同 |
| 工具集 | 完全相同 | 完全相同 |

---

## 控制指令

在飞书群内发送以下指令可直接控制 Bridge，**不会转发给 Copilot ACP**：

| 指令 | 说明 |
|------|------|
| `!status` | Bridge 回复最近 10 行日志（post 格式，换行正常显示） |
| `!stop` | 发送 ACP `session_cancel` 信令，立即打断当前 prompt 操作；session 保持，队列清空 |

---

## Bridge 可视化监控

ACP Server 窗口在 `--acp` 模式下无任何输出，**Bridge 窗口**是完整的监控面板：

```
[Bridge][EVENT] 收到消息 [group] ou:a951b → "你是谁"
[Bridge][INFO]  转发原始事件给 Copilot...
  🔧 [pending] Using skill: lark-im
      输入: {"skillName":"lark-im"}
  ✅ [completed] tooluse_xxx
  🔧 [pending] Reply to message om_xxx
      输入: {"message_id":"om_xxx","text":"你好！..."}
  ✅ [completed] tooluse_yyy
你好！我是大波龙...          ← Copilot 回复流式实时输出（青色）
[Bridge][INFO]  Copilot 处理完成：...
```

---

## 文件说明

### `lark-acp-bridge.mjs`

Node.js 桥接脚本，负责：
1. 连接本地 ACP Server（TCP 3000 端口）
2. 初始化 Copilot AI 会话
3. 订阅飞书 IM 消息事件（`im.message.receive_v1`）
4. 将原始事件 JSON 转发给 Copilot ACP
5. Copilot Agent 自行解析并用 lark-im skill 回复飞书

---

## Agent 配置

Copilot CLI 会自动加载 `~/.copilot/agents/` 根目录下的所有 `.agent.md` 文件，通过 `--agent <name>` 在启动时指定。

**Agent 文件结构：**

```
~/.copilot/agents/
└── dawbolong.agent.md        ← Copilot 加载（必须在根目录）+ 经验记录追加在末尾

{cwd}/
└── AGENTS.md                 ← 每次启动由 launch.sh 从 dawbolong.agent.md 覆盖同步（Copilot 自动读取）
```

> ⚠️ Copilot CLI **不扫描子目录**，`.agent.md` 必须在根目录。

```
---
name: dawbolong
description: 大波龙 — vendy 的全能 AI 助手
---
（角色定义、能力、飞书消息处理规则）
```

**当前 Agent 设定（大波龙）：**

- **身份**：vendytam 在本机的私人全能 AI 助手
- **工作目录**：D:\WorkSpaceClaw
- **权限**：读写文件、执行命令、调用飞书（lark-im）、联网搜索
- **飞书消息处理**：收到原始事件 JSON → 解析 content → 用 lark-im +messages-reply 回复，不只输出文字
- **效率原则**：闲聊/问答类消息直接从已知信息回答，**禁止调用 shell**；只有用户明确要求执行操作才用工具，目标是最少工具调用数
- **记忆机制**：解决非显而易见的问题后自动追加到 `~/.copilot/agents/dawbolong.agent.md` 末尾，遇到技术类问题先读取文件末尾经验记录参考

**修改方式：** 直接编辑 `~/.copilot/agents/dawbolong.agent.md`，重启后（新建会话）自动生效。

**Agent 身份注入机制（AGENTS.md 同步）：**

`launch.sh` 每次启动时，把选中的 `~/.copilot/agents/<agent>.agent.md` 内容覆盖写入 `{cwd}/AGENTS.md`。Copilot CLI 启动时自动读取工作目录下的 `AGENTS.md` 作为自定义指令，从而让 Agent 知道自己的身份和行为规范。经验记录追加到 agent.md 末尾，下次启动自动同步到 AGENTS.md。

---

## 启动方式（当前实现，Git Bash）

### 一键启动

```bash
cd /d/Workspace/LarkCli2Copilot
bash launch.sh
```

启动时交互选择 Agent、工作目录和会话：
```
[ 选择 Agent ]
  0) 不使用 Agent
  1) dawbolong   大波龙 — vendy 的全能 AI 助手...

  请输入编号 [0-1]: 1

[ 工作目录 ]
  默认：D:\WorkSpaceClaw
  输入工作目录（直接回车使用默认）: _
  （支持退格/方向键编辑；目录不存在时自动创建）

[ 会话选择 ]
  上次会话 ID：b124c034...28c324c
  1) 恢复上次对话（--continue）（推荐）
  2) 开始全新对话
  请输入编号 [1-2]:
```

- **工作目录**：直接回车使用 agent 文件配置的默认目录，或输入自定义路径；支持退格/方向键；目录不存在时自动创建
- 选 **1**：Bridge 用 `loadSession` 复用上次 session ID（对话历史延续）
- 选 **2**：删除 `.acp-session-id`，创建全新会话
- 首次启动（无历史）：跳过会话选择，直接创建新会话

或跳过交互直接指定：
```bash
bash launch.sh --agent=dawbolong --cwd='D:\Workspace\MyProject'  # 路径含反斜杠需加引号
bash launch.sh --new               # 强制全新会话，不询问
bash launch.sh --continue          # 直接恢复，不询问
bash launch.sh --model=gpt-5.2

# 完全无交互一键启动
bash launch.sh --agent=dawbolong --cwd='D:\WorkSpaceClaw' --new
bash launch.sh --agent=dawbolong --cwd='D:\WorkSpaceClaw' --continue
```

> ⚠️ **路径参数**：Windows 路径含反斜杠时需加单引号，否则 bash 会吃掉反斜杠导致 `loadSession` 失败。

### 手动分步启动

```bash
# 窗口 1：ACP Server
bash start-copilot-acp.sh
bash start-copilot-acp.sh --agent=dawbolong --model=claude-sonnet-4.6

# 窗口 2：Bridge
node lark-acp-bridge.mjs
```

---

## 依赖

| 依赖 | 说明 |
|------|------|
| `copilot` CLI | GitHub Copilot CLI，已登录 |
| `lark-cli` | 飞书命令行工具，已配置 App ID/Secret |
| `node` | Node.js v18+ |
| `git-bash` | Git Bash（mintty 弹窗） |
| `@agentclientprotocol/sdk` | ACP 客户端 SDK（npm install 已安装） |

---

## 注意事项

- **单实例限制**：`lark-cli event +subscribe` 每个 App 同时只能有一个订阅实例
- **ACP 窗口空白正常**：`--acp` 模式下终端无输出，工作过程全在 Bridge 窗口可见
- **ACP 会话持久化**：Bridge 自动将 session ID 存入 `.acp-session-id`；重启时 `launch.sh` 询问是否恢复，选恢复则 Bridge 用 `loadSession` 复用旧 session（ACP Server 本身无需 `--continue`），选新会话则清除文件创建新 session；首次启动无此提示
- **飞书平台配置**：需在飞书开放平台控制台开启"长连接接收事件"并订阅 `im.message.receive_v1` 事件
- **Agent prompt 要点**：明确告知 Agent 用 lark-im 发回复（否则只输出文字）；闲聊类消息禁止调用 shell，避免响应变慢
- **表情回应**：Agent 每次回复前必须先对原消息添加 emoji reaction，使用 `lark-cli im reactions create`，**根据消息内容选择合适表情**（确认→`OK`/`DONE`、提问→`THINKING`、报错→`SWEAT`、有趣→`LOL` 等），不要固定用 THUMBSUP
- **消息格式**：含 JSON/代码片段的回复必须用 `--markdown` 参数；在 PowerShell `--text` 双引号字符串中使用 `\"` 会导致消息在 `{"` 处被截断；**`--markdown` 不支持 Markdown 表格**（会被丢弃），改用列表格式
- **Agent 文件必须在根目录**：Copilot CLI 只扫描 `~/.copilot/agents/*.agent.md`，**不支持子目录**；经验记录追加到 agent.md 本身末尾，无需子文件夹；`launch.sh` 启动时自动同步最新内容到 `{cwd}/AGENTS.md`
- **消息日志**：Bridge 收到消息时展示发送者ID后缀和消息预览（`ou:a951b → "你好"`），便于监控

---

## 扩展思路

- **持久化 session ID**：✅ 已实现——Bridge 自动写入 `.acp-session-id`，`launch.sh` 启动时询问是否恢复
- **多事件类型**：扩展订阅 `contact`、`calendar` 等事件，实现更丰富的自动化
- **stdio 模式**：改用 `copilot --acp --stdio`，Bridge 直接 spawn Copilot，简化为单窗口架构

