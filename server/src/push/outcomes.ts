/**
 * Delivery-outcome interpretation: which failures are worth retrying, which
 * mean the token itself is dead, and how an outcome is logged.
 *
 * The two classifiers are pure predicates over a provider response, which is
 * the whole point of keeping them out of the transport: "a 404 with reason
 * `UNREGISTERED` prunes the device" is a rule that can be tested directly
 * instead of through a mocked HTTPS stack.
 */

import type { PushAttemptResult, PushDeliveryOutcome } from './types.ts';

/**
 * Returns true when a failed result is likely transient and worth retrying.
 */
export function isRetryable(result: { statusCode?: number; } | null | undefined): boolean {
  const sc = result?.statusCode;
  // No status (network error), rate-limited, or server-side error
  return !sc || sc === 429 || sc >= 500;
}

/**
 * Status codes that can carry a dead-token (unregistered / malformed) reason.
 * Both FCM's direct HTTP v1 path and Azure Notification Hubs' `FcmV1` direct
 * send relay these same underlying codes/reasons, so the same check applies
 * to either transport.
 */
const DEAD_TOKEN_STATUS_CODES = new Set([404, 400]);

/**
 * Matches FCM HTTP v1's canonical error-status enum values for a dead token
 * (`UNREGISTERED` for a 404, `INVALID_ARGUMENT` for a malformed token on a
 * 400) — see https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
 * — plus common human-readable variants Notification Hubs or APNs may wrap
 * the same underlying failure in.
 */
const DEAD_TOKEN_REASON_PATTERN =
  /unregistered|invalid_argument|invalid.*registration.*token|baddevicetoken/i;

/**
 * Determine whether a failed delivery result indicates the push token itself
 * is dead (the app was uninstalled / the token was rotated away) rather than
 * a transient failure. Dead-token results must never be retried and must
 * cause the offending device row to be pruned so it stops silently
 * swallowing future pushes.
 */
export function isDeadTokenResult(result: PushAttemptResult | null | undefined): boolean {
  if (!result || result.ok) return false;
  if (result.statusCode === undefined) return false;
  if (!DEAD_TOKEN_STATUS_CODES.has(result.statusCode)) return false;
  return typeof result.reason === 'string' && DEAD_TOKEN_REASON_PATTERN.test(result.reason);
}

/**
 * Log the outcome of a delivery attempt for operational visibility.
 *
 * @param outcome
 * @param description - Event description, e.g. `call.incoming callId=…`.
 */
export function logDeliveryOutcome(
  outcome: Omit<PushDeliveryOutcome, 'transport' | 'deadToken'> & {
    transport: string;
    deadToken?: boolean;
  },
  description: string
): void {
  if (outcome.ok) {
    if (outcome.transport === 'notification_hub') {
      console.log(
        `[push] Accepted by hub ${description}` +
          ` via ${outcome.provider} to device=${outcome.deviceId}` +
          ` status=${outcome.statusCode ?? 'N/A'}` +
          ` trackingId=${outcome.trackingId ?? 'N/A'}`
      );
    } else {
      console.log(
        `[push] Accepted by provider ${description}` +
          ` via ${outcome.provider} to device=${outcome.deviceId}` +
          ` status=${outcome.statusCode ?? 'N/A'}`
      );
    }
    return;
  }
  console.error(
    `[push] Failed to deliver ${description}` +
      ` via ${outcome.provider} to device=${outcome.deviceId}` +
      ` status=${outcome.statusCode ?? 'N/A'} reason=${outcome.reason ?? 'unknown'}` +
      (outcome.deadToken ? ' deadToken=true' : '')
  );
}
