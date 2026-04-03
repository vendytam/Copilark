#!/usr/bin/env bash
# launch.sh
# 一键启动：自动弹出两个 Git Bash 窗口
#   窗口 1 — Copilot ACP Server
#   窗口 2 — Lark ACP Bridge
#
# 用法：
#   ./launch.sh                        # 启动时选择 Agent
#   ./launch.sh --continue             # 恢复上次 Copilot 会话
#   ./launch.sh --resume=<id>          # 恢复指定会话
#   ./launch.sh --port=4000            # 自定义端口
#   ./launch.sh --agent=my-agent       # 跳过选择，直接指定 Agent
#   ./launch.sh --model=gpt-5.2        # 指定模型

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3000
ACP_FLAGS=""
SESSION_NOTE="新会话"
SELECTED_AGENT=""   # 由参数或交互选择决定
BRIDGE_CWD=""       # Bridge/ACP 工作目录，空则交互选择
FORCE_NEW=0         # --new：强制创建新会话，跳过会话选择
FORCE_CONTINUE=0    # --continue：直接恢复，跳过会话选择交互
BRIDGE_ONLY=0       # --bridge-only：只重启 Bridge，保留已有 ACP Server

# ─── 解析参数 ──────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --port=*)    PORT="${arg#--port=}" ;;
    --agent=*)   SELECTED_AGENT="${arg#--agent=}" ;;
    --cwd=*)
      BRIDGE_CWD="${arg#--cwd=}"
      # 修复 bash 吃掉反斜杠的问题：D:WorkSpaceClaw → D:\WorkSpaceClaw
      if [[ "$BRIDGE_CWD" =~ ^([A-Za-z]:)([^/\\].*)$ ]]; then
        BRIDGE_CWD="${BRIDGE_CWD:0:2}\\${BRIDGE_CWD:2}"
      fi
      ;;
    --model=*)   ACP_FLAGS="$ACP_FLAGS $arg" ;;
    --new)         FORCE_NEW=1 ;;
    --continue)    FORCE_CONTINUE=1; SESSION_NOTE="恢复上次会话" ;;
    --resume=*)  ACP_FLAGS="$ACP_FLAGS $arg";       SESSION_NOTE="恢复 ${arg#--resume=}" ;;
    *) echo "[WARN] 未知参数: $arg" ;;
  esac
done
ACP_FLAGS="${ACP_FLAGS# }"  # 去掉开头空格

# ─── 工具函数 ──────────────────────────────────────────────────────────────────
ok()   { echo "  [OK] $*"; }
fail() { echo "  [NG] $*" >&2; }

# ─── Agent 选择 ────────────────────────────────────────────────────────────────
# 扫描 ~/.copilot/agents/ 下所有 *.agent.md，提取 name 字段，让用户选择

select_agent() {
  local agents_dir="$USERPROFILE/.copilot/agents"
  # 转成 Unix 路径（Git Bash）
  agents_dir="$(cygpath -u "$agents_dir" 2>/dev/null || echo "$agents_dir")"

  # 收集所有 agent 名字和描述
  local names=()
  local descs=()
  if [ -d "$agents_dir" ]; then
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      local name desc
      name=$(grep -m1 '^name:' "$f" | sed 's/^name:[[:space:]]*//' | tr -d '"' | tr -d "'")
      desc=$(grep -m1 '^description:' "$f" | sed 's/^description:[[:space:]]*//' | tr -d '"' | cut -c1-50)
      [ -n "$name" ] && names+=("$name") && descs+=("${desc:-（无描述）}")
    done < <(find "$agents_dir" -maxdepth 1 -name "*.agent.md" -type f)
  fi

  if [ ${#names[@]} -eq 0 ]; then
    echo "  [!!] 未找到任何 Agent（~/.copilot/agents/ 为空），将不使用 Agent 启动"
    SELECTED_AGENT=""
    return
  fi

  echo ""
  echo "[ 选择 Agent ]"
  echo "  0) 不使用 Agent（默认 Copilot）"
  local i
  for i in "${!names[@]}"; do
    printf "  %d) %-20s  %s\n" "$((i+1))" "${names[$i]}" "${descs[$i]}"
  done
  echo ""

  local choice
  while true; do
    read -r -p "  请输入编号 [0-${#names[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 0 ] && [ "$choice" -le "${#names[@]}" ]; then
      break
    fi
    echo "  请输入有效编号"
  done

  if [ "$choice" -eq 0 ]; then
    SELECTED_AGENT="__none__"   # 明确标记：不使用 Agent
    echo "  → 不使用 Agent"
  else
    SELECTED_AGENT="${names[$((choice-1))]}"
    echo "  → 已选择: $SELECTED_AGENT"
  fi
}

# 如果命令行未指定 --agent，则交互选择
if [ -z "$SELECTED_AGENT" ]; then
  select_agent
fi

# 将选中的 agent 拼入 ACP_FLAGS
if [ "$SELECTED_AGENT" = "__none__" ]; then
  ACP_FLAGS="$ACP_FLAGS --no-agent"   # 明确禁止 start-copilot-acp.sh 的默认 agent
elif [ -n "$SELECTED_AGENT" ]; then
  ACP_FLAGS="$ACP_FLAGS --agent=$SELECTED_AGENT"
fi
ACP_FLAGS="${ACP_FLAGS# }"

# ─── 工作目录选择 ─────────────────────────────────────────────────────────────
if [ -z "$BRIDGE_CWD" ]; then
  echo ""
  echo "[ 工作目录 ]"
  # 读取 agent 文件里的默认工作目录（defaultWorkDir 或 WorkSpaceClaw 等）
  DEFAULT_CWD="$USERPROFILE/WorkSpaceClaw"
  # 尝试从 agent 文件提取默认工作目录
  AGENT_FILE="$USERPROFILE/.copilot/agents/${SELECTED_AGENT}.agent.md"
  if [ -f "$AGENT_FILE" ]; then
    extracted=$(grep -m1 '默认工作目录' "$AGENT_FILE" | grep -oP '(?<=：)[^\s]+' | head -1)
    [ -n "$extracted" ] && DEFAULT_CWD="$extracted"
  fi
  # 转为 Unix 路径
  DEFAULT_CWD_UNIX="$(cygpath -u "$DEFAULT_CWD" 2>/dev/null || echo "$DEFAULT_CWD")"
  echo "  默认：$DEFAULT_CWD"
  echo ""
  read -e -r -p "  输入工作目录（直接回车使用默认）: " input_cwd
  if [ -n "$input_cwd" ]; then
    BRIDGE_CWD="$input_cwd"
  else
    BRIDGE_CWD="$DEFAULT_CWD"
  fi
  echo "  → 工作目录：$BRIDGE_CWD"
fi

# ─── 会话恢复选择 ─────────────────────────────────────────────────────────────
SESSION_FILE="$DIR/.acp-session-id"
RESUME_SESSION=0

# 如果命令行已明确指定 --continue 或 --resume，跳过交互
if [ "$FORCE_CONTINUE" -eq 1 ] || [[ "$ACP_FLAGS" == *"--resume"* ]]; then
  : # 已指定，不处理
elif [ "$FORCE_NEW" -eq 1 ]; then
  rm -f "$SESSION_FILE"
  SESSION_NOTE="全新会话"
  echo "  → [--new] 强制创建全新会话"
elif [ -f "$SESSION_FILE" ]; then
  SAVED_ID="$(cat "$SESSION_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$SAVED_ID" ]; then
    echo ""
    echo "[ 会话选择 ]"
    printf "  上次会话 ID：%s\n" "${SAVED_ID:0:8}...${SAVED_ID: -8}"
    echo ""
    echo "  1) 恢复上次对话（--continue）（推荐）"
    echo "  2) 开始全新对话"
    echo ""
    while true; do
      read -r -p "  请输入编号 [1-2]: " choice
      [[ "$choice" == "1" || "$choice" == "2" ]] && break
      echo "  请输入 1 或 2"
    done
    if [ "$choice" == "1" ]; then
      # 不传 --continue 给 ACP Server；Bridge 用 loadSession 接续会话
      SESSION_NOTE="恢复上次会话"
      RESUME_SESSION=1
      echo "  → 将恢复上次会话"
    else
      rm -f "$SESSION_FILE"
      SESSION_NOTE="全新会话"
      echo "  → 将开始全新会话"
    fi
  fi
fi

# 在新 Git Bash 窗口中执行命令（基于 mintty，Git Bash 内置终端）
open_new_bash_window() {
  local title="$1"
  local cmd="$2"
  # mintty -t 设置窗口标题，-e 指定要运行的程序
  # 命令结束后用 read 保持窗口开着，方便查看日志
  /usr/bin/mintty --title "$title" -e bash -c "$cmd; echo ''; echo '--- 进程已退出，按 Enter 关闭 ---'; read" &
}

# ─── 环境检查 ──────────────────────────────────────────────────────────────────
# 加载可选的本地 env 文件（存放 SYSBUILDER_TOKEN 等敏感配置，不提交 git）
if [ -f "$DIR/.env.local" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$DIR/.env.local"
  set +a
  ok ".env.local 已加载"
fi

echo ""
echo "========================================"
echo "   Copilark  Launch (Git Bash)"
echo "========================================"
echo ""
echo "[ 环境检查 ]"

FAIL=0

command -v copilot  &>/dev/null && ok "copilot CLI 已安装"   || { fail "未找到 copilot"; FAIL=1; }
command -v lark-cli &>/dev/null && ok "lark-cli 已安装"       || { fail "未找到 lark-cli"; FAIL=1; }
command -v node     &>/dev/null && ok "Node.js $(node -v)"    || { fail "未找到 node"; FAIL=1; }

if [ -d "$DIR/node_modules/@agentclientprotocol/sdk" ]; then
  ok "ACP SDK 已安装"
else
  echo "  [..] 正在安装 npm 依赖..."
  (cd "$DIR" && npm install --silent)
  [ -d "$DIR/node_modules/@agentclientprotocol/sdk" ] \
    && ok "ACP SDK 安装完成" \
    || { fail "npm install 失败，请手动执行"; FAIL=1; }
fi

if [ -x /usr/bin/mintty ]; then
  ok "mintty 已就绪"
else
  fail "未找到 /usr/bin/mintty，请确认在 Git Bash 环境中运行"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "请修复以上问题后重试。"
  exit 1
fi

# ─── 启动两个窗口 ──────────────────────────────────────────────────────────────
echo ""
echo "[ 启动 ]"

# 窗口 1：ACP Server
ACP_CMD="bash '${DIR}/start-copilot-acp.sh' --port=${PORT} ${ACP_FLAGS}"
open_new_bash_window "Copilot ACP Server :$PORT" "$ACP_CMD"
ok "窗口 1 已打开 — Copilot ACP Server（$SESSION_NOTE，端口 $PORT）"

# 等待 ACP Server 端口就绪
echo "  [..] 等待 ACP Server 端口 $PORT 就绪..."
WAITED=0
while [ "$WAITED" -lt 30 ]; do
  sleep 1
  WAITED=$((WAITED + 1))
  if bash -c "echo > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
    ok "ACP Server 端口就绪（${WAITED}s）"
    break
  fi
  printf "\r  等待中... (%d/30 s)" "$WAITED"
done
if [ "$WAITED" -ge 30 ]; then
  echo ""
  echo "  [!!] ACP Server 未在 30s 内响应，Bridge 会自动重试连接"
fi
BRIDGE_CWD_WIN="$(cygpath -w "$BRIDGE_CWD" 2>/dev/null || echo "$BRIDGE_CWD")"
# 将选中的 agent.md 覆盖写入 cwd/AGENTS.md（Copilot 自动读取，保证每次启动都是最新身份）
if [ -n "$SELECTED_AGENT" ] && [ "$SELECTED_AGENT" != "__none__" ]; then
  AGENT_FILE_UNIX="$(cygpath -u "$USERPROFILE" 2>/dev/null || echo "$USERPROFILE")/.copilot/agents/${SELECTED_AGENT}.agent.md"
  AGENT_MD_DEST="$BRIDGE_CWD/AGENTS.md"
  if [ -f "$AGENT_FILE_UNIX" ]; then
    mkdir -p "$BRIDGE_CWD"
    cp "$AGENT_FILE_UNIX" "$AGENT_MD_DEST"
    ok "AGENTS.md 已同步到 $AGENT_MD_DEST"
  else
    warn "Agent 文件不存在，跳过同步：$AGENT_FILE_UNIX"
  fi
fi
BRIDGE_CMD="cd '$DIR' && BRIDGE_CWD='${BRIDGE_CWD_WIN}' SYSBUILDER_TOKEN='${SYSBUILDER_TOKEN:-}' SYSBUILDER_BACKEND_URL='${SYSBUILDER_BACKEND_URL:-http://47.79.4.19}' node lark-acp-bridge.mjs"
open_new_bash_window "Lark ACP Bridge" "$BRIDGE_CMD"
ok "窗口 2 已打开 — Lark ACP Bridge  (cwd: $BRIDGE_CWD, agent: ${SELECTED_AGENT:-无})"

# ─── 完成 ─────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Ready!  两个窗口均已启动"
echo "========================================"
echo ""
echo "  ACP Server : tcp://127.0.0.1:$PORT"
echo "  Bridge     : 订阅 im.message.receive_v1"
echo ""
echo "  停止：在各窗口按 Ctrl+C"
echo ""
