#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DEBUG_API_TOKEN:-}" ]; then
  echo 'deploy metrics probe: DEBUG_API_TOKEN is not set; run via robot-deploy-metrics-probe.service' >&2
  exit 1
fi

url="${ROBOT_METRICS_URL:-http://127.0.0.1:${PORT:-4173}/metrics}"
if ! status="$(curl --silent --show-error --fail --connect-timeout 5 --max-time 15 \
  --header @- --output /dev/null --write-out '%{http_code}' "$url" \
  <<<"x-debug-token: ${DEBUG_API_TOKEN}")" || [ "$status" != 200 ]; then
  echo 'deploy metrics probe: /metrics did not return HTTP 200' >&2
  exit 1
fi
