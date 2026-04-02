#!/usr/bin/env bash
# install.sh
# 将 copilark 全局命令安装到 ~/bin/，之后可在任意目录直接执行 copilark
#
# 用法：
#   bash install.sh
#
# 安装后：
#   copilark              # 等价于 bash /path/to/launch.sh
#   copilark --continue   # 透传任意参数

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/bin"
TARGET="$BIN_DIR/copilark"

# 创建 ~/bin 目录
mkdir -p "$BIN_DIR"

# 写入 copilark 脚本
cat > "$TARGET" <<EOF
#!/usr/bin/env bash
exec bash "$DIR/launch.sh" "\$@"
EOF
chmod +x "$TARGET"

# 生成 Windows .cmd 包装（供 PowerShell / cmd 调用）
CMD_TARGET="$BIN_DIR/copilark.cmd"
cat > "$CMD_TARGET" <<'CMDEOF'
@echo off
bash "%USERPROFILE%\bin\copilark" %*
CMDEOF

echo "[OK] copilark 已安装到 $TARGET"
echo "[OK] copilark.cmd 已安装到 $CMD_TARGET（供 PowerShell / cmd 使用）"

# 检查 ~/bin 是否在 PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "[!!] $BIN_DIR 不在 PATH，请将以下内容添加到 ~/.bashrc 或 ~/.bash_profile："
  echo "     export PATH=\"\$HOME/bin:\$PATH\""
  echo "     然后执行：source ~/.bashrc"
else
  echo "[OK] $BIN_DIR 已在 PATH，可直接使用 copilark"
fi
