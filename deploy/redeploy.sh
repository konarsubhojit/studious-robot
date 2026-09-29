#!/usr/bin/env bash
set -euo pipefail

repo=/home/wetalk/repos/studious-robot
svc=robot-signal.service
snapshot="${ROBOT_METRICS_SNAPSHOT:-/usr/local/bin/robot-metrics-snapshot.sh}"

"$snapshot" pre-deploy || true

sudo -u wetalk -H bash -lc "
  set -euo pipefail
  cd '$repo'
  git pull --ff-only
  cd server
  npm ci
  npm run db:migrate
" || { echo 'redeploy: install or migration failed, not restarting' >&2; exit 1; }

sudo systemctl restart "$svc"
sleep 2
"$snapshot" post-deploy || true
sudo systemctl status "$svc" --no-pager
