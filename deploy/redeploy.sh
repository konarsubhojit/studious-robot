#!/usr/bin/env bash
set -euo pipefail

repo="${ROBOT_REDEPLOY_REPO:-/home/wetalk/repos/studious-robot}"
svc=robot-signal.service
health_url="${ROBOT_REDEPLOY_HEALTH_URL:-http://127.0.0.1:${PORT:-4173}/health}"

run_as_wetalk() {
  local directory="$1"
  shift
  sudo -n -u wetalk -H bash -lc "cd \"\$1\" && shift && exec \"\$@\"" redeploy "$directory" "$@"
}

if ! run_as_wetalk "$repo" git pull --ff-only; then
  echo 'redeploy: pull failed, not restarting' >&2
  exit 1
fi

if ! run_as_wetalk "$repo/server" npm ci; then
  echo 'redeploy: install failed, not restarting' >&2
  exit 1
fi

if ! run_as_wetalk "$repo/server" npm run db:migrate; then
  echo 'redeploy: migrate failed, not restarting' >&2
  exit 1
fi

if ! run_as_wetalk "$repo/server" node scripts/check-pending-migrations.ts; then
  echo 'redeploy: pending migrations verification failed, not restarting' >&2
  exit 1
fi

if ! run_as_wetalk "$repo/server" npm prune --omit=dev; then
  echo 'redeploy: install prune failed, not restarting' >&2
  exit 1
fi

if ! sudo -n systemctl restart "$svc"; then
  echo "redeploy: restart failed: could not restart $svc" >&2
  exit 1
fi
if ! sudo -n systemctl is-active --quiet "$svc"; then
  echo "redeploy: restart failed: $svc is not active" >&2
  exit 1
fi

health_response=""
for ((i = 1; i <= 20; i++)); do
  if health_response="$(curl -fsS --connect-timeout 5 --max-time 15 "$health_url" 2>/dev/null)" &&
    jq -e '.status == "ok"' >/dev/null 2>&1 <<<"$health_response"; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo 'redeploy: health failed after restart' >&2
    exit 1
  fi
  if ! sleep 2; then
    echo 'redeploy: health failed after restart while waiting to retry' >&2
    exit 1
  fi
done

if ! jq -e '
  .hydration | type == "object" and
  ([.users, .devices, .calls, .callEvents, .blocks, .accountDeletions] |
    all(. != null and (.status == "succeeded" or .status == "skipped")))
' >/dev/null 2>&1 <<<"$health_response"; then
  echo 'redeploy: hydration failed or incomplete after restart' >&2
  exit 1
fi

# Shared state is required for the multi-VM fleet, but the standalone
# deployment expectation has not been confirmed, so affinity remains a warning.
state_affinity="$(jq -r '.stateAffinity // "unknown"' <<<"$health_response" 2>/dev/null || printf unknown)"
echo "redeploy: health stateAffinity=$state_affinity"
if [ "$state_affinity" != shared ]; then
  echo "redeploy: warning: health stateAffinity=$state_affinity (expected shared for the multi-VM fleet)" >&2
fi

if ! sudo -n systemctl start --wait robot-deploy-metrics-probe.service; then
  echo 'redeploy: metrics probe failed after restart' >&2
  exit 1
fi
if ! sudo -n systemctl status "$svc" --no-pager; then
  echo "redeploy: restart failed: could not read status for $svc" >&2
  exit 1
fi
