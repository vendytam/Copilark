快速开始（AI Agent）
以下步骤面向 AI Agent，部分步骤需要用户在浏览器中配合完成。

适用范围：本文档只用于独立安装并启动 Copilark，不包含 SysBuilder / Electron 集成步骤。

## 前置条件
- Windows 操作系统
- Node.js v18+
- Git Bash（Git for Windows 附带，用于执行脚本）
- GitHub 账号（已登录 GitHub CLI）
- 飞书应用凭证（App ID + App Secret）

## 安装步骤

#第 1 步 — 安装 Lark CLI
安装 CLI
npm install -g @larksuite/cli
安装 CLI SKILL（必需）
npx skills add larksuite/cli -y -g

Windows 安装注意（重要）：
- **推荐使用官方 Node.js 安装器并保持默认全局 npm 路径**，不要用 portable Node、绿色版 Node，或手动执行 `npm config set prefix D:\\...` 把全局包装到自定义目录。
- Copilark 在 Windows 下更稳定的形态是：
  - `lark-cli.exe`
  - 或 `node.exe <...>\\@larksuite\\cli\\bin\\lark-cli.js`
- **最容易出问题的是**：只暴露出 `lark-cli.cmd`，并且实际执行退回 `shell=true`。这种情况下，飞书消息里的中文 / emoji 参数可能被 Windows `cmd` 包装层截断或转义异常。

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

#第 2 步 — 配置应用凭证
在后台运行此命令，命令会输出一个授权链接，提取该链接并发送给用户，用户在浏览器中完成配置后命令会自动退出。
lark-cli config init --new

#第 3 步 — 登录
同上，后台运行，提取授权链接发给用户。
lark-cli auth login --recommend

#第 4 步 — 验证
lark-cli auth status

#第 5 步 - 安装 Copilot CLI（GitHub 账号必需）
在后台运行以下命令，完成后会要求在浏览器中登录 GitHub：
```
npm install -g @github-copilot/cli
gh auth login
```
验证安装：
```
copilot --version
```

#第 6 步 - 克隆并安装 Copilark 项目
```
git clone -b feature/sysbuilder-analysis --single-branch https://github.com/vendytam/Copilark.git
cd Copilark
npm install
bash install.sh
```
验证依赖安装（ACP SDK）：
```
node -e "import('@agentclientprotocol/sdk').then(()=>console.log('OK'))"
```

#第 7 步 - 初始化 Agent 配置
参考项目内 `agents/dawbolong.agent.md` 模板（Copilark 根目录下），在 `~\.copilot\agents\` 中创建 `dawbolong.agent.md`。

**步骤：**
1. 打开 GitHub 仓库 https://github.com/vendytam/Copilark/blob/feature/sysbuilder-analysis/agents/dawbolong.agent.md
2. 复制全部内容
3. 在本地创建 `~\.copilot\agents\dawbolong.agent.md` 并粘贴
4. 编辑，将占位符替换为实际值：
   - `YOUR_NAME` → 你的名字
   - `YOUR_CWD` → 默认工作目录路径

然后启动时 `launch.sh` 会自动同步到 `{cwd}/AGENTS.md`。

#第 8 步 - 将 Bot 添加到飞书群聊
提醒用户打开：https://open.feishu.cn/app
找到对应应用 → 机器人 → 将机器人添加至目标群聊。

#第 9 步 - 配置飞书应用事件与权限
提醒用户打开：https://open.feishu.cn/app
找到事件与回调；
事件只开启：
	接收消息v2.0
	im.message.receive_v1
权限：
	接收群聊中@机器人消息事件 
	读取用户发给机器人的单聊消息
	获取群组中所有消息（敏感权限）
只开启以上权限

#第 10 步 - 启动 Copilark
在任意目录运行：
```
copilark
```
脚本会：
1. 询问选择 Agent（选 dawbolong）
2. 询问工作目录（直接回车使用默认，或输入路径；目录不存在会自动创建）
3. 自动打开两个窗口：Copilot ACP Server + Lark Bridge

启动成功后，先在目标飞书群里 @机器人 发一条消息，或者先私聊 Bot 一条消息，确认 Bridge 已记录当前可用 chat_id 后再继续使用。
