#!/usr/bin/env bash
set -Eeuo pipefail

export OCI_CLI_AUTH=instance_principal
OCI_BIN=/home/ubuntu/bin/oci
BUCKET=kiyonbucket

set -a
. /etc/robot-signal/env
set +a

# Healthy small-dataset dumps are 24-32 KB; 15 KB catches wrong/empty sources.
MIN_SIZE="${MIN_SIZE:-15000}"
if [[ ! "$MIN_SIZE" =~ ^[0-9]+$ ]]; then
  echo "backup aborted: MIN_SIZE must be a non-negative integer" >&2
  exit 1
fi

STAMP=$(date -u +%Y/%m/%d/%H%M%SZ)
umask 077
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! pg_dump -Fc -d "${DATABASE_URL:?}" > "$TMP"; then
  rm -f "$TMP"
  echo "backup aborted: pg_dump failed" >&2
  exit 1
fi
SIZE=$(stat -c%s "$TMP")

# A wrong or empty database can dump successfully but contain little data.
# Reject suspiciously small dumps rather than polluting backup history.
if (( SIZE < MIN_SIZE )); then
  echo "backup aborted: dump is too small (${SIZE} bytes; minimum ${MIN_SIZE})" >&2
  exit 1
fi

MD5=$(md5sum "$TMP" | cut -d' ' -f1)
CONTENT_MD5=$(openssl dgst -md5 -binary "$TMP" | base64)
echo "uploading pg/${STAMP}.dump (${SIZE} bytes, md5 ${MD5})"
if ! "$OCI_BIN" os object put -bn "$BUCKET" \
  --name "pg/${STAMP}.dump" --file "$TMP" --content-md5 "$CONTENT_MD5" \
  --auth instance_principal --force; then
  echo "backup aborted: OCI upload failed" >&2
  exit 1
fi
