#!/usr/bin/env bash
# GitHub's own download counts for the releases on ccch1mneyyy/dsh-go: a
# supplement to scripts/stats.sh. GitHub counts every download of an asset,
# from anywhere: the page's GitHub button, the release page, apps updating
# through GitHub and the accelerator mirrors (update.json counts their checks).
# Totals since each release, not per day.
#
#   scripts/github-downloads.sh            all releases
#   scripts/github-downloads.sh --dry-run  print the gh command, run nothing
#
#   GH_TOKEN_FILE  optional; otherwise gh's own login (the repo is public, so
#                  any login works; the API is 60 requests an hour without one)
set -euo pipefail

REPO=ccch1mneyyy/dsh-go
DRY=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
cmd=(gh api --paginate "repos/$REPO/releases?per_page=100")
if [[ $DRY == 1 ]]; then
  echo "dry run: ${cmd[*]} | jq (release, published, asset, download_count)"
  exit 0
fi
command -v gh >/dev/null && command -v jq >/dev/null || { echo "github-downloads: needs gh and jq" >&2; exit 1; }
gh_() { if [[ -n "${GH_TOKEN_FILE:-}" ]]; then GH_TOKEN="$(tr -d '[:space:]' <"$GH_TOKEN_FILE")" gh "$@"; else gh "$@"; fi; }

# --paginate prints one JSON array per page: slurp and join them.
gh_ "${cmd[@]:1}" | jq -s 'add // []' | jq -r '
  (["release", "published", "asset", "downloads"] | @tsv),
  (.[] | select(.draft | not) | . as $r
    | (.assets | sort_by(.name))[]
    | [$r.tag_name + (if $r.prerelease then " (pre)" else "" end), (($r.published_at // "") | .[0:10]), .name, (.download_count | tostring)] | @tsv),
  (["", "", "APKs in all", ([.[] | select(.draft | not) | .assets[] | select(.name | endswith(".apk")) | .download_count] | add // 0 | tostring)] | @tsv)
' | column -t -s $'\t'
