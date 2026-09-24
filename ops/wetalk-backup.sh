#!/usr/bin/env bash
set -Eeuo pipefail

export OCI_CLI_AUTH=instance_principal
# The unit runs as User=root, so the CLI must live outside any user's home:
# a /home/<user>/bin path is unreadable under ProtectHome= and disappears if
# that account is removed. /opt/oci-cli is the documented install location
# (see deploy/README.md); override OCI_BIN for a different one.
OCI_BIN="${OCI_BIN:-/opt/oci-cli/bin/oci}"
AGE_BIN="${AGE_BIN:-/usr/bin/age}"
BUCKET="${BACKUP_BUCKET:-kiyonbucket}"

# The live unit has no EnvironmentFile=, so the script sources the env itself.
# DATABASE_URL and BACKUP_AGE_RECIPIENT both come from here.
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/robot-signal/env}"
if [[ -r "$BACKUP_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

# Public key of the backup recipient. The matching *private* key must never
# live on this VM: a compromised instance should be able to write backups it
# cannot read back.
#
# The repo unit has OnFailure=wetalk-backup-failure.service. The older `oci`
# host does not; see docs/VM_REDEPLOY.md for that live-host drift.
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
if [[ -z "$BACKUP_AGE_RECIPIENT" ]]; then
  echo "backup aborted: BACKUP_AGE_RECIPIENT is unset — refusing to upload a plaintext dump" >&2
  exit 1
fi
if [[ ! -x "$AGE_BIN" ]]; then
  echo "backup aborted: age not found at ${AGE_BIN} (apt-get install age)" >&2
  exit 1
fi
if [[ ! -x "$OCI_BIN" ]]; then
  echo "backup aborted: oci CLI not found at ${OCI_BIN} (set OCI_BIN)" >&2
  exit 1
fi

# Dumps are ~141 KB after the 2026-09-23 removal of ~400 users (they were
# ~1.1 MB before it). 100 KB catches a wrong or empty source without tripping
# on ordinary variation. Measured on the *plaintext* dump.
MIN_SIZE="${MIN_SIZE:-100000}"
if [[ ! "$MIN_SIZE" =~ ^[0-9]+$ ]]; then
  echo "backup aborted: MIN_SIZE must be a non-negative integer" >&2
  exit 1
fi
MIN_PREVIOUS_SIZE_PERCENT="${MIN_PREVIOUS_SIZE_PERCENT:-50}"
if [[ ! "$MIN_PREVIOUS_SIZE_PERCENT" =~ ^[0-9]+$ ]] || (( MIN_PREVIOUS_SIZE_PERCENT > 100 )); then
  echo "backup aborted: MIN_PREVIOUS_SIZE_PERCENT must be an integer between 0 and 100" >&2
  exit 1
fi

STAMP=$(date -u +%Y/%m/%d/%H%M%SZ)
umask 077
TMP=$(mktemp)
ENC=$(mktemp)
trap 'rm -f -- "$TMP" "$ENC"' EXIT

# Stage to a file rather than piping straight to OCI: a pg_dump that dies
# part-way must not leave a truncated object in the bucket.
if ! pg_dump -Fc -d "${DATABASE_URL:?}" > "$TMP"; then
  echo "backup aborted: pg_dump failed" >&2
  exit 1
fi
SIZE=$(stat -c%s "$TMP")

if (( SIZE < MIN_SIZE )); then
  echo "backup aborted: dump is too small (${SIZE} bytes; minimum ${MIN_SIZE})" >&2
  exit 1
fi

# Verify the dump is structurally readable before trusting it.
if ! pg_restore --list "$TMP" >/dev/null 2>&1; then
  echo "backup aborted: dump failed pg_restore --list verification" >&2
  exit 1
fi

# Encrypt before anything leaves this host.
if ! "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$ENC" "$TMP"; then
  echo "backup aborted: age encryption failed" >&2
  exit 1
fi
shred -u -- "$TMP" 2>/dev/null || rm -f -- "$TMP"
ENC_SIZE=$(stat -c%s "$ENC")
if (( ENC_SIZE == 0 )); then
  echo "backup aborted: encrypted dump is empty" >&2
  exit 1
fi

# Compare ciphertext against the previous *ciphertext* only: both sides of
# this guard are the size of the age-encrypted object, never the plaintext
# dump (MIN_SIZE above is the plaintext floor). The historical pg/*.dump
# objects are plaintext, predate the user removal, and are not a like-for-like
# baseline. Filtering and sorting are done in the shell rather than in
# JMESPath: an unsupported --query projection fails open by returning the
# newest object of *any* kind, which silently defeats the filter.
#
# Objects are keyed pg/%Y/%m/%d/%H%M%SZ.dump.age, so the listing must use the
# bare pg/ prefix — scoping it to today's date directory finds nothing on the
# first run of a day. That key layout sorts lexicographically in timestamp
# order, so the last line is the newest object.
#
# --fields name,size is required: the CLI omits size otherwise and the size
# lookup yields nothing. The list output is pretty-printed across several
# lines per object, so it is flattened to one line before matching the
# name/size pair.
if (( MIN_PREVIOUS_SIZE_PERCENT > 0 )); then
  PREVIOUS_SIZE_RAW=$(
    "$OCI_BIN" os object list -bn "$BUCKET" --prefix "pg/" \
      --auth instance_principal --all --fields name,size \
      --query 'data[*].{name:name,size:size}' --output json 2>/dev/null \
      | tr '\n' ' ' \
      | tr -s ' ' \
      | grep -oE '"name": ?"pg/[^"]+\.age", ?"size": ?[0-9]+' \
      | sort \
      | tail -n1 \
      | grep -oE '[0-9]+$' \
      || true
  )
  if [[ -z "$PREVIOUS_SIZE_RAW" ]]; then
    echo "backup warning: no previous encrypted dump; static MIN_SIZE guard only" >&2
  elif [[ ! "$PREVIOUS_SIZE_RAW" =~ ^[0-9]+$ ]]; then
    echo "backup warning: previous dump size was non-numeric (${PREVIOUS_SIZE_RAW}); static MIN_SIZE guard only" >&2
  elif (( ENC_SIZE * 100 < PREVIOUS_SIZE_RAW * MIN_PREVIOUS_SIZE_PERCENT )); then
    echo "backup aborted: encrypted dump shrank too much (${ENC_SIZE} bytes; previous ${PREVIOUS_SIZE_RAW}; minimum ${MIN_PREVIOUS_SIZE_PERCENT}% of previous, both encrypted)" >&2
    exit 1
  fi
fi

MD5=$(md5sum "$ENC" | cut -d' ' -f1)
CONTENT_MD5=$(openssl dgst -md5 -binary "$ENC" | base64 -w0)
echo "uploading pg/${STAMP}.dump.age (${ENC_SIZE} bytes encrypted, ${SIZE} plaintext, md5 ${MD5})"
if ! "$OCI_BIN" os object put -bn "$BUCKET" \
  --name "pg/${STAMP}.dump.age" --file "$ENC" --content-md5 "$CONTENT_MD5" \
  --auth instance_principal --no-multipart --force; then
  echo "backup aborted: OCI upload failed" >&2
  exit 1
fi