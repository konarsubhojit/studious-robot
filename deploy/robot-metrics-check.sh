#!/usr/bin/env bash
set -uo pipefail

LOG_DIR="${ROBOT_METRICS_LOG_DIR:-/var/log/robot-metrics}"
CHECK_LOG="${LOG_DIR}/checks.log"
SNAPSHOT_LOG="${LOG_DIR}/snapshots.jsonl"
METRICS_URL="${ROBOT_METRICS_URL:-http://localhost:4173/metrics}"
ENV_FILE="${ROBOT_METRICS_ENV_FILE:-/etc/robot-metrics.env}"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
if [ -z "${DEBUG_API_TOKEN:-}" ]; then
  mkdir -p "$LOG_DIR"
  printf '%s FAIL DEBUG_API_TOKEN_not_set\n' "$now" >>"$CHECK_LOG"
  exit 1
fi

mkdir -p "$LOG_DIR"
raw="$(mktemp)"
record="$(mktemp)"
trap 'rm -f "$raw" "$record"' EXIT

if ! curl --silent --show-error --fail --connect-timeout 5 --max-time 15 \
  -H "x-debug-token: ${DEBUG_API_TOKEN}" "$METRICS_URL" >"$raw"; then
  printf '%s FAIL metrics_unreachable\n' "$now" >>"$CHECK_LOG"
  exit 1
fi

if ! jq -e -c '
  if type == "object"
     and (.counters | type) == "object"
     and (.histograms | type) == "object"
     and (.derived | type) == "object"
     and (.dbQueries | type) == "array"
  then .
  else error("unexpected metrics response shape")
  end
' "$raw" >"$record"; then
  printf '%s FAIL metrics_invalid_json\n' "$now" >>"$CHECK_LOG"
  exit 1
fi

previous="$(tail -n 1 "$SNAPSHOT_LOG" 2>/dev/null || true)"
previous_marker=""
previous_valid=0
if [ -n "$previous" ] && jq -e '
  (.counters.calls_initiated | type) == "number" and
  (.counters.messages_persisted_total | type) == "number" and
  (.counters.db_queries_total | type) == "number"
' >/dev/null 2>&1 <<<"$previous"; then
  previous_valid=1
  previous_marker="$(jq -r '.restartMarker // empty' <<<"$previous")"
fi

calls="$(jq -er '.counters.calls_initiated // 0' "$record")" || exit 1
messages="$(jq -er '.counters.messages_persisted_total // 0' "$record")" || exit 1
queries="$(jq -er '.counters.db_queries_total // 0' "$record")" || exit 1
reset=0
reset_reason=()
if [ "$previous_valid" -eq 1 ]; then
  old_calls="$(jq -er '.counters.calls_initiated' <<<"$previous")" || exit 1
  old_messages="$(jq -er '.counters.messages_persisted_total' <<<"$previous")" || exit 1
  old_queries="$(jq -er '.counters.db_queries_total' <<<"$previous")" || exit 1
  [ "$calls" -lt "$old_calls" ] && reset_reason+=("calls_initiated_decreased")
  [ "$messages" -lt "$old_messages" ] && reset_reason+=("messages_persisted_total_decreased")
  [ "$queries" -lt "$old_queries" ] && reset_reason+=("db_queries_total_decreased")
  [ "${#reset_reason[@]}" -gt 0 ] && reset=1
fi

if [ "$reset" -eq 1 ] || [ -z "$previous_marker" ]; then
  marker="$now"
else
  marker="$previous_marker"
fi
reason_json="$(printf '%s\n' "${reset_reason[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')"

if ! jq -e -c \
  --arg t "$now" --arg marker "$marker" --argjson reset "$reset" --argjson reason "$reason_json" '
  . + {
    t: $t,
    restartMarker: $marker,
    reset: ($reset == 1),
    resetReason: $reason,
    pg: (.histograms.pg_query_duration_ms // {}),
    loop: (.histograms.event_loop_lag_ms // {}),
    loopMax: (.histograms.event_loop_lag_max_ms // {}),
    redis: (.histograms.redis_query_duration_ms // {}),
    dbq: (.dbQueries // []),
    setup: (.histograms.call_setup_latency_ms // {}),
    connect: (.histograms.call_connect_latency_ms // {}),
    ring: (.histograms.call_ring_duration_ms // {}),
    duration: (.histograms.call_duration_ms // {}),
    cacheRate: (.derived.cache_hit_rate // null)
  }
' "$record" >>"$SNAPSHOT_LOG"; then
  printf '%s FAIL snapshot_write\n' "$now" >>"$CHECK_LOG"
  exit 1
fi

if [ "$reset" -eq 1 ]; then
  printf '%s RESET restartMarker=%s reason=%s\n' "$now" "$marker" "$(IFS=,; echo "${reset_reason[*]}")" >>"$CHECK_LOG"
fi

if ! statuses="$(jq -r '
  [
    (if (.counters.calls_ended // 0) > (.counters.calls_initiated // 0)
      then "ANOMALY calls_ended_exceeds_calls_initiated" else empty end),
    (if (.counters.message_persist_errors // 0) > 0
      then "ANOMALY message_persist_errors=\(.counters.message_persist_errors)" else empty end),
    (if (.counters.db_query_errors_total // 0) > 0
      then "ANOMALY db_query_errors_total=\(.counters.db_query_errors_total)" else empty end),
    (if (.counters.rtc_relays_no_recipient // 0) > 0
      then "WARN rtc_relays_no_recipient=\(.counters.rtc_relays_no_recipient)" else empty end),
    (if (.derived.messages_delivery_marking_gap // 0) > 0
      then "WARN delivery_marking_gap=\(.derived.messages_delivery_marking_gap)" else empty end),
    (if (.counters.signaling_errors // 0) > 0
      then "WARN signaling_errors=\(.counters.signaling_errors)" else empty end),
    (if (.counters.db_slow_queries_total // 0) > 0
      then "WARN db_slow_queries_total=\(.counters.db_slow_queries_total)" else empty end),
    (if (.histograms.pg_query_duration_ms.max // 0) > 100
      then "PERF pg_query_duration_ms.max=\(.histograms.pg_query_duration_ms.max)" else empty end),
    (if (.histograms.event_loop_lag_max_ms.max // 0) > 100
      then "PERF event_loop_lag_max_ms.max=\(.histograms.event_loop_lag_max_ms.max)" else empty end),
    (if (.histograms.event_loop_lag_ms.mean // 0) > 10
      then "PERF event_loop_lag_ms.mean=\(.histograms.event_loop_lag_ms.mean)" else empty end),
    (if ((.counters.cache_hits // 0) + (.counters.cache_misses // 0)) >= 100
         and (.derived.cache_hit_rate // 1) < .20
      then "PERF cache_hit_rate=\(.derived.cache_hit_rate)" else empty end),
    (if (.histograms.call_connect_latency_ms.mean // 0) > 5000
      then "PERF call_connect_latency_ms.mean=\(.histograms.call_connect_latency_ms.mean)" else empty end),
    (if (.histograms.redis_query_duration_ms.max // 0) > 50
      then "PERF redis_query_duration_ms.max=\(.histograms.redis_query_duration_ms.max)" else empty end)
  ] | .[]
' "$record")"; then
  printf '%s FAIL jq_invariant_check\n' "$now" >>"$CHECK_LOG"
  exit 1
fi

if [ -n "$statuses" ]; then
  while IFS= read -r status; do
    printf '%s %s\n' "$now" "$status" >>"$CHECK_LOG"
  done <<<"$statuses"
elif [ "$reset" -eq 0 ]; then
  printf '%s OK calls=%s msgs=%s\n' "$now" "$calls" "$messages" >>"$CHECK_LOG"
fi
