#!/usr/bin/env bash
set -uo pipefail

label="${1:-}"
case "$label" in
  pre-deploy|post-deploy|manual) ;;
  *) printf 'usage: %s {pre-deploy|post-deploy|manual}\n' "$0" >&2; exit 2 ;;
esac

LOG_DIR="${ROBOT_METRICS_LOG_DIR:-/var/log/robot-metrics}"
FINAL_DIR="${LOG_DIR}/final"
METRICS_URL="${ROBOT_METRICS_URL:-http://localhost:4173/metrics}"
ENV_FILE="${ROBOT_METRICS_ENV_FILE:-/etc/robot-metrics.env}"
REPO="${ROBOT_REPO:-/home/wetalk/repos/studious-robot}"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
if [ -z "${DEBUG_API_TOKEN:-}" ]; then
  printf '%s snapshot failed: DEBUG_API_TOKEN is not set (load /etc/robot-metrics.env via systemd)\n' "$now" >&2
  exit 1
fi
mkdir -p "$FINAL_DIR" || exit 0
rev="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || printf 'unknown')"
tmp="$(mktemp)"
target="${FINAL_DIR}/${stamp}-${label}.json"
final_tmp="$(mktemp "${FINAL_DIR}/.snapshot.XXXXXX")"
trap 'rm -f "$tmp" "$final_tmp"' EXIT

if curl --silent --show-error --fail --connect-timeout 5 --max-time 15 \
  -H "x-debug-token: ${DEBUG_API_TOKEN}" "$METRICS_URL" >"$tmp" &&
  jq -e --arg label "$label" --arg rev "$rev" --arg t "$now" '
    if (type == "object") then . + {_label: $label, _gitRev: $rev, _snapshotAt: $t}
    else error("metrics is not an object")
    end
  ' "$tmp" >"$final_tmp" &&
  mv -f "$final_tmp" "$target"; then
  :
else
  printf '%s snapshot failed\n' "$now" >&2
fi

"${ROBOT_METRICS_CHECK:-/usr/local/bin/robot-metrics-check.sh}" || true
exit 0
