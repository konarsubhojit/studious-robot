#!/usr/bin/env bash
set -e
PM2_PORT="${PORT:-}"
set -a
. /etc/robot-signal/env
set +a
[ -n "$PM2_PORT" ] && export PORT="$PM2_PORT"
exec /usr/bin/node src/index.ts
