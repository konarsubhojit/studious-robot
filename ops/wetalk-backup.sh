#!/usr/bin/env bash
set -Eeuo pipefail

export OCI_CLI_AUTH=instance_principal
OCI_BIN=/home/ubuntu/bin/oci
BUCKET=kiyonbucket
MIN_SIZE="${MIN_SIZE:-15000}"
STAMP=$(date -u +%Y/%m/%d/%H%M%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

set -a
. /etc/robot-signal/env
set +a

if [[ ! "$MIN_SIZE" =~ ^[0-9]+$ ]]; then
  echo "backup aborted: MIN_SIZE must be a non-negative integer" >&2
  exit 1
fi

pg_dump -Fc -d "${DATABASE_URL:?}" > "$TMP"
SIZE=$(stat -c%s "$TMP")

# A stale duplicate database can dump successfully but contain little data.
# Reject suspiciously small dumps rather than polluting backup history.
if (( SIZE < MIN_SIZE )); then
  echo "backup aborted: dump is too small (${SIZE} bytes; minimum ${MIN_SIZE})" >&2
  exit 1
fi

echo "uploading pg/${STAMP}.dump (${SIZE} bytes, md5 $(md5sum "$TMP" | cut -d' ' -f1))"
"$OCI_BIN" os object put -bn "$BUCKET" \
  --name "pg/${STAMP}.dump" --file "$TMP" --force
