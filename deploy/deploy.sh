#!/usr/bin/env bash
#
# deploy.sh — pull the latest code and (re)start the robot-signal service.
#
# Runs on the OCI VM (invoked by the GitHub Actions SSH deploy step, or manually
# over SSH). It performs a single, idempotent deploy cycle:
#
#   1. Fetch and hard-reset the checkout to the target branch (pull changes).
#   2. Install production dependencies for the server.
#   3. Restart the systemd service so the new code is picked up.
#   4. Verify the service came back up (non-zero exit if it did not).
#
# The restart uses `systemctl reload-or-restart` so in-flight calls drain
# gracefully (see TimeoutStopSec in robot-signal.service) and the service is
# started if it was not already running.
#
# Environment overrides (all optional):
#   REPO_DIR      Path to the git checkout (default: ~/repos/studious-robot)
#   DEPLOY_BRANCH Branch to deploy            (default: master)
#   SERVICE_NAME  systemd unit to restart     (default: robot-signal)
#   DEPLOY_RUNTIME process manager: systemd|pm2 (default: systemd)
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/repos/studious-robot}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-master}"
SERVICE_NAME="${SERVICE_NAME:-robot-signal}"
DEPLOY_RUNTIME="${DEPLOY_RUNTIME:-systemd}"

echo "[deploy] repo=${REPO_DIR} branch=${DEPLOY_BRANCH} runtime=${DEPLOY_RUNTIME} service=${SERVICE_NAME}"

# 1. Pull the latest code.
cd "${REPO_DIR}"
git fetch --quiet origin "${DEPLOY_BRANCH}"
git reset --hard "origin/${DEPLOY_BRANCH}"

# 2. Install production dependencies.
cd server
npm ci --omit=dev

# 3. Restart the service after pulling changes.
if [[ "${DEPLOY_RUNTIME}" == "pm2" ]]; then
  pm2 reload "${REPO_DIR}/deploy/ecosystem.config.js" --update-env || pm2 start "${REPO_DIR}/deploy/ecosystem.config.js"
  sleep 2
  if pm2 describe "${SERVICE_NAME}" >/dev/null 2>&1; then
    echo "[deploy] ${SERVICE_NAME} is running under pm2"
  else
    echo "[deploy] ERROR: ${SERVICE_NAME} did not become active under pm2" >&2
    exit 1
  fi
else
  # systemd path (default): graceful, rolling-friendly.
  sudo systemctl reload-or-restart "${SERVICE_NAME}"
  sleep 2
  if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "[deploy] ${SERVICE_NAME} is running"
  else
    echo "[deploy] ERROR: ${SERVICE_NAME} did not become active" >&2
    exit 1
  fi
fi
