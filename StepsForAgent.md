## 快速开始（AI Agent）

以下步骤面向 AI Agent，部分步骤需要用户在浏览器中配合完成。

适用范围：本文档只用于**独立安装并启动 Copilark**，不包含 SysBuilder / Electron 集成步骤。

---

## 前置条件

- Windows 操作系统
- Node.js v18+
- Git Bash（Git for Windows 附带，用于执行脚本）
- GitHub 账号
- 飞书应用凭证（App ID + App Secret）

> 说明：
> - `lark-cli` 推荐按官方 AI Agent 流程安装与认证
> - `copilot` CLI 在后续步骤中单独安装

---

## 第 1 步 — 安装 lark-cli

按官方推荐方式安装：

```powershell
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

### Windows 安装注意（重要）

- **推荐使用官方 Node.js 安装器并保持默认全局 npm 路径**
- 不要使用 portable Node、绿色版 Node，或手动执行 `npm config set prefix D:\...` 把全局包装到自定义目录
- Copilark 在 Windows 下更稳定的执行入口是：
  - `lark-cli.exe`
  - 或 `node.exe <...>\@larksuite\cli\bin\lark-cli.js`
- **最容易出问题的形态**是：只暴露 `lark-cli.cmd`，并且实际执行退回 `shell=true`。这种情况下，飞书消息里的中文 / emoji 参数可能被 Windows `cmd` 包装层截断或转义异常

安装后请立刻自检：

```powershell
where lark-cli
npm root -g
Test-Path ((npm root -g) + '\@larksuite\cli\bin\lark-cli.js')
```

如果你看到：

- `where lark-cli` 只返回 `*.cmd`
- 并且 `lark-cli.js` 不存在

请优先重装为默认 Node/npm 全局路径，再继续后续步骤。

如果暂时无法重装，也可以在启动 Bridge 前**强制指定执行入口**：

```powershell
$env:LARK_NODE_PATH="D:\Program Files\nodejs\node.exe"
$env:LARK_CLI_JS_PATH="C:\Users\<你>\AppData\Roaming\npm\node_modules\@larksuite\cli\bin\lark-cli.js"
```

或直接指定 exe：

```powershell
$env:LARK_CLI_PATH="C:\Users\<你>\AppData\Roaming\npm\node_modules\@larksuite\cli\bin\lark-cli.exe"
```

优先级说明：

1. `LARK_CLI_JS_PATH + LARK_NODE_PATH`
2. `LARK_CLI_PATH`
3. 自动探测（最后才会退回 `.cmd + shell=true`）

---

## 第 2 步 — 配置飞书应用凭证

按 `lark-cli` 官方 AI Agent 流程，后台运行：

```powershell
lark-cli config init --new
```

命令会输出一个授权链接。AI Agent 需要提取该链接并发送给用户，用户在浏览器中完成配置后，命令会自动退出。

> 说明：如果你按这条推荐路径走，很多应用配置会由飞书 / `lark-cli` 自动引导完成，不需要一开始手工逐项配置。

---

## 第 3 步 — 登录并授权

同样按官方推荐流程执行：

```powershell
lark-cli auth login --recommend
```

命令会输出授权链接。AI Agent 需要将链接发给用户，等待用户在浏览器中完成授权。

> 说明：`--recommend` 会优先帮你走一条更稳的推荐权限路径。大多数场景下，不需要你手工逐条配置 scope。

---

## 第 4 步 — 验证 lark-cli 是否可用

```powershell
lark-cli auth status
```

建议同时做一次最小自检：

```powershell
where lark-cli
lark-cli auth status
```

---

## 第 5 步 — 安装 Copilot CLI

在后台运行以下命令，完成后按提示登录 GitHub：

```powershell
npm install -g @github-copilot/cli
gh auth login
copilot --version
```

---

## 第 6 步 — 克隆并安装 Copilark

```powershell
git clone -b feature/sysbuilder-analysis --single-branch https://github.com/vendytam/Copilark.git
cd Copilark
npm install
bash install.sh
```

验证 ACP SDK 是否已安装：

```powershell
node -e "import('@agentclientprotocol/sdk').then(()=>console.log('OK'))"
```

---

## 第 7 步 — 初始化 Agent 配置

参考项目内 `agents/dawbolong.agent.md` 模板（Copilark 根目录下），在 `~\.copilot\agents\` 中创建 `dawbolong.agent.md`。

步骤：

1. 打开 GitHub 仓库：`https://github.com/vendytam/Copilark/blob/feature/sysbuilder-analysis/agents/dawbolong.agent.md`
2. 复制全部内容
3. 在本地创建 `~\.copilot\agents\dawbolong.agent.md`
4. 将模板内容粘贴进去
5. 替换占位符：
   - `YOUR_NAME` → 你的名字
   - `YOUR_CWD` → 默认工作目录路径

然后启动时，`launch.sh` 会自动同步到 `{cwd}/AGENTS.md`。

---

## 第 8 步 — 将 Bot 添加到飞书群聊

提醒用户打开：<https://open.feishu.cn/app>

找到对应应用 → 机器人 → 将机器人添加至目标群聊。

---

## 第 9 步 — 检查飞书事件与权限（仅作兜底）

如果你已经按下面两步完成：

- `lark-cli config init --new`
- `lark-cli auth login --recommend`

那么大部分应用配置与授权通常会被自动引导完成。  
这一节主要作为**异常排查的兜底检查**，不是推荐的主路径。

如需手动检查，请提醒用户打开：<https://open.feishu.cn/app>

重点确认：

### 1. 事件订阅方式

- 使用**长连接接收事件**

### 2. 事件

- `im.message.receive_v1`

### 3. 如果 Bot 无法正常收发消息，再检查相关权限

当前 Copilark 的最小必需能力是：

- 能接收消息事件
- 能发送消息回复

如果实际运行出现“能收到但不能发”或“完全收不到”的情况，再去对照开放平台中的 IM 权限与机器人能力配置逐项排查。

---

## 第 10 步 — 启动 Copilark

在任意目录运行：

```powershell
copilark
```

脚本会：

1. 询问选择 Agent（选 `dawbolong`）
2. 询问工作目录（直接回车使用默认，或输入路径；目录不存在会自动创建）
3. 自动打开两个窗口：Copilot ACP Server + Lark Bridge

启动成功后，先在目标飞书群里 @机器人 发一条消息，或者先私聊 Bot 一条消息，确认 Bridge 已记录当前可用 `chat_id` 后再继续使用。

---

## 启动后的快速验证

建议最少确认以下几项：

```powershell
copilot --version
lark-cli auth status
node -e "import('@agentclientprotocol/sdk').then(()=>console.log('OK'))"
```

然后在飞书里完成一次最小联通测试：

1. 在目标群中 @Bot 发一句话
2. 确认 Bridge 已收到消息
3. 确认 Bot 能正常回复

如果这三步都正常，说明 Copilark 的基础链路已经可用。
