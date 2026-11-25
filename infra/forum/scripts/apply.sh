#!/usr/bin/env bash
# 在论坛服务器上执行：把 settings/ 下的设置写进正在运行的 Discourse。
#
#   sudo infra/forum/scripts/apply.sh
#
# 可重复执行。要求容器已经用 containers/app.yml 构建并在运行（./launcher rebuild app）。
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
if grep -q '<<FILL' "$FORUM/settings/site_settings.yml"; then
  echo "提示：site_settings.yml 里还有 <<FILL 占位符，这些项会被跳过" >&2
fi

install -d -m 0755 "$STAGE"
install -m 0644 "$HERE/apply_settings.rb" "$STAGE/apply_settings.rb"
install -m 0644 "$FORUM/settings/site_settings.yml" "$STAGE/site_settings.yml"
install -m 0644 "$FORUM/settings/community.yml" "$STAGE/community.yml"
if [[ -f "$FORUM/settings/secrets.yml" ]]; then
  # 容器里的 rails 以 discourse 用户运行，需要能读到；执行完立即删除
  install -m 0644 "$FORUM/settings/secrets.yml" "$STAGE/secrets.yml"
fi
trap 'rm -f "$STAGE/secrets.yml"' EXIT

docker exec "$CONTAINER" rails runner /shared/dshgo/apply_settings.rb /shared/dshgo
