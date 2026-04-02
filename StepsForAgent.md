快速开始（AI Agent）
以下步骤面向 AI Agent，部分步骤需要用户在浏览器中配合完成。

#第 1 步 — 安装
安装 CLI
npm install -g @larksuite/cli
安装 CLI SKILL（必需）
npx skills add larksuite/cli -y -g

#第 2 步 — 配置应用凭证
在后台运行此命令，命令会输出一个授权链接，提取该链接并发送给用户，用户在浏览器中完成配置后命令会自动退出。
lark-cli config init --new

#第 3 步 — 登录
同上，后台运行，提取授权链接发给用户。
lark-cli auth login --recommend

#第 4 步 — 验证
lark-cli auth status

#第 5 步 - copilot cli安装
在后台运行以下命令，完成后会要求在浏览器中登录 GitHub：
```
npm install -g @github-copilot/cli
gh auth login
```
验证安装：
```
copilot --version
```

#第 6 步 - 安装 Copilark
```
git clone https://github.com/YOUR_GITHUB_USERNAME/Copilark.git
cd Copilark
npm install
bash install.sh
```
验证依赖安装（ACP SDK）：
```
node -e "import('@agentclientprotocol/sdk').then(()=>console.log('OK'))"
```

#第 7 步 - 初始AGENT设置
参考 `agents/dawbolong.agent.md` 模板，在 `~\.copilot\agents\` 中创建 `dawbolong.agent.md`，将模板内容复制过去后，将占位符替换为实际值：
- `YOUR_NAME` → 你的名字
- `YOUR_CWD` → 默认工作目录路径

然后启动时 `launch.sh` 会自动同步到 `{cwd}/AGENTS.md`。

<!-- ─── 经验记录（由 Agent 追加） ───────────────────────────────────────────── -->

### [2026-03-31] --markdown 不支持 Markdown 表格
**问题**：`--markdown` 将内容转为 post 格式的 `md` tag，飞书不渲染其中的 Markdown 表格，内容被丢弃只剩前后文字
**方案**：消息中用有序/无序列表（`-` 或 `1.`）替代表格

### [2026-03-31] PowerShell --text 中 \" 转义导致消息截断
**问题**：`--text "...{\"key\":\"value\"}..."` 在 PowerShell 中 `\"` 不是合法转义，导致消息在 `{"` 处提前截断
**方案**：回复含 JSON / 代码示例时改用 `--markdown` 参数；若必须用 `--text`，双引号用反引号转义

### [2026-03-31] lark-cli +messages-reply 无 --at 参数
**问题**：`lark-cli im +messages-reply` 没有 `--at` 参数，无法直接 @用户
**方案**：在 `--text` 内容中使用 `<at user_id="open_id"></at>` 标签实现 @mention

### [2026-04-01] Windows 高DPI屏幕截图
**问题**：有屏幕缩放时用 `System.Windows.Forms.Screen` 截图不全（只截到逻辑分辨率）
**方案**：用 Python + pywin32 + pillow，调用 `SetProcessDpiAwareness(2)` + `GetDeviceCaps` 获取物理分辨率，再用 BitBlt 截图

#第 8 步 - 飞书群聊中添加Bot
提醒用户打开：https://open.feishu.cn/app
找到对应应用 → 机器人 → 将机器人添加至目标群聊。

#第 9 步 - 飞书App事件与回调设置
提醒用户打开：https://open.feishu.cn/app
找到事件与回调；
事件只开启：
	接收消息v2.0
	im.message.receive_v1
权限：
	接收群聊中@机器人消息事件 
	读取用户发给机器人的单聊消息
只开启以上权限

#第 10 步 - 开启Copilark
在任意目录运行：
```
copilark
```
脚本会：
1. 询问选择 Agent（选 dawbolong）
2. 询问工作目录（直接回车使用默认，或输入路径；目录不存在会自动创建）
3. 自动打开两个窗口：Copilot ACP Server + Lark Bridge

启动成功后，在飞书群 @机器人 发一条消息测试即可,或者私聊Bot。
