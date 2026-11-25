#!/usr/bin/env bash
# 在论坛服务器上执行：打包 theme-dshgo 并安装 / 更新到正在运行的 Discourse。
#
#   sudo infra/forum/scripts/install_theme.sh
#
# 之后在 后台 → 外观 → 主题 → dsh-go 分享码卡片 → 设置 里填「download_url」。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORUM="$(dirname "$HERE")"
SHARED="${DISCOURSE_SHARED:-/var/discourse/shared/standalone}"
CONTAINER="${DISCOURSE_CONTAINER:-app}"
STAGE="$SHARED/dshgo"

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 执行（sudo）" >&2
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "容器 $CONTAINER 没在运行：先 cd /var/discourse && ./launcher rebuild app" >&2
  exit 1
fi

install -d -m 0755 "$STAGE"
tar -C "$FORUM" -czf "$STAGE/theme-dshgo.tar.gz" theme-dshgo
chmod 0644 "$STAGE/theme-dshgo.tar.gz"
install -m 0644 "$HERE/install_theme.rb" "$STAGE/install_theme.rb"

docker exec "$CONTAINER" rails runner /shared/dshgo/install_theme.rb /shared/dshgo/theme-dshgo.tar.gz
