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
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/repos/studious-robot}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-master}"
SERVICE_NAME="${SERVICE_NAME:-robot-signal}"

echo "[deploy] repo=${REPO_DIR} branch=${DEPLOY_BRANCH} service=${SERVICE_NAME}"

# 1. Pull the latest code.
cd "${REPO_DIR}"
git fetch --quiet origin "${DEPLOY_BRANCH}"
git reset --hard "origin/${DEPLOY_BRANCH}"

# 2. Install production dependencies.
cd server
npm ci --omit=dev

# 3. Restart the service after pulling changes. Graceful, rolling-friendly:
#    systemd sends SIGTERM, the app drains in-flight connections, then the new
#    process starts. reload-or-restart starts the service if it is not running.
sudo systemctl reload-or-restart "${SERVICE_NAME}"

# 4. Verify the service came back up; fail the deploy if it did not.
sleep 2
if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "[deploy] ${SERVICE_NAME} is running"
else
  echo "[deploy] ERROR: ${SERVICE_NAME} did not become active" >&2
  exit 1
fi
