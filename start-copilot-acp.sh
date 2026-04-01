#!/usr/bin/env bash
# start-copilot-acp.sh
# 启动 Copilot ACP Server（Git Bash 版）
#
# 用法：
#   ./start-copilot-acp.sh                        # 使用默认 Agent（大波龙）
#   ./start-copilot-acp.sh --continue             # 恢复上次会话
#   ./start-copilot-acp.sh --resume=<id>          # 恢复指定会话
#   ./start-copilot-acp.sh --port=4000            # 自定义端口
#   ./start-copilot-acp.sh --agent=other-agent    # 覆盖默认 Agent
#   ./start-copilot-acp.sh --model=gpt-5.2        # 指定模型
#   ./start-copilot-acp.sh --no-agent             # 不使用任何 Agent

set -euo pipefail

PORT=3000
AGENT="dawbolong"   # 默认使用大波龙 Agent
MODEL=""
NO_AGENT=""
ACP_EXTRA_ARGS=()
SESSION_NOTE="就绪"

# ─── 解析参数 ──────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --port=*)      PORT="${arg#--port=}" ;;
    --agent=*)     AGENT="${arg#--agent=}" ;;
    --model=*)     MODEL="${arg#--model=}" ;;
    --no-agent)    NO_AGENT=1 ;;
    --continue)    ACP_EXTRA_ARGS+=("$arg"); SESSION_NOTE="恢复会话" ;;
    --resume=*)    ACP_EXTRA_ARGS+=("$arg");       SESSION_NOTE="恢复会话 ${arg#--resume=}" ;;
    *) echo "[WARN] 未知参数: $arg" ;;
  esac
done

[ -z "$NO_AGENT" ] && [ -n "$AGENT" ] && ACP_EXTRA_ARGS+=("--agent" "$AGENT")
[ -n "$MODEL" ] && ACP_EXTRA_ARGS+=("--model" "$MODEL")

# ─── 检查依赖 ──────────────────────────────────────────────────────────────────
if ! command -v copilot &>/dev/null; then
  echo "[ERROR] 未找到 copilot 命令，请安装 GitHub Copilot CLI" >&2
  exit 1
fi

# ─── 启动信息 ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Copilot ACP Server ==="
echo "端口   : $PORT"
echo "会话   : $SESSION_NOTE（由 Bridge loadSession 管理）"
[ -z "$NO_AGENT" ] && echo "Agent  : ${AGENT:-（未指定）}"
[ -n "$MODEL" ]    && echo "模型   : $MODEL"
echo "命令   : copilot --acp --port $PORT --allow-all ${ACP_EXTRA_ARGS[*]:-}"
echo ""
echo "就绪后请在另一个终端启动 Bridge："
echo "  node lark-acp-bridge.mjs"
echo ""
echo "按 Ctrl+C 停止"
echo "─────────────────────────────────────"
echo ""

# ─── 启动 ────────────────────────────────────────────────────────────────────
exec copilot --acp --port "$PORT" --allow-all "${ACP_EXTRA_ARGS[@]}"
