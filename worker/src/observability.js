// @ts-check

const METRIC_INDEX = "wp-collab-cloudflare";
const METRIC_EVENTS = new Set([
  "configuration_invalid",
  "connection_accepted",
  "connection_rejected",
  "resource_limit",
]);
const METRIC_STATUSES = new Set([
  "auth_unavailable",
  "byte_rate_exceeded",
  "configuration_invalid",
  "connection_limit_exceeded",
  "connection_state_limit_exceeded",
  "document_limit_exceeded",
  "expired_token",
  "inactive_token",
  "invalid_claims",
  "invalid_lifetime",
  "invalid_protocol",
  "invalid_signature",
  "invalid_token",
  "malformed_yjs_message",
  "malformed_yjs_update",
  "message_limit_exceeded",
  "message_rate_exceeded",
  "missing_key_id",
  "missing_token",
  "origin_mismatch",
  "rate_limit_exceeded",
  "room_mismatch",
  "token_in_url",
  "unknown_key_id",
  "unknown_site",
  "update_limit_exceeded",
  "upgraded",
]);

/**
 * Emit one privacy-safe count event. The allowlists are deliberately closed:
 * request-derived strings, identifiers, and content can never become labels.
 * Analytics is optional and best-effort so it cannot affect relay availability.
 *
 * Schema:
 * - index1: constant service name (sampling key)
 * - blob1: bounded event name
 * - blob2: bounded status/reason
 * - double1: event count (always 1)
 * - double2: non-negative observed numeric value, or 0
 * - double3: non-negative configured numeric limit, or 0
 *
 * @param {AnalyticsEngineDataset | undefined} dataset
 */
export function recordConfigurationInvalid(dataset) {
  recordMetric(dataset, "configuration_invalid", "configuration_invalid");
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {string} status
 */
export function recordConnectionRejected(dataset, status) {
  recordMetric(dataset, "connection_rejected", status);
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 */
export function recordConnectionAccepted(dataset) {
  recordMetric(dataset, "connection_accepted", "upgraded");
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {string} status
 * @param {number} [observed]
 * @param {number} [limit]
 */
export function recordResourceLimit(dataset, status, observed, limit) {
  recordMetric(dataset, "resource_limit", status, observed, limit);
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {string} event
 * @param {string} status
 * @param {number} [observed]
 * @param {number} [limit]
 */
function recordMetric(dataset, event, status, observed, limit) {
  if (!dataset) {
    return;
  }

  try {
    dataset.writeDataPoint({
      indexes: [METRIC_INDEX],
      blobs: [
        METRIC_EVENTS.has(event) ? event : "unknown",
        METRIC_STATUSES.has(status) ? status : "unknown",
      ],
      doubles: [1, boundedNumber(observed), boundedNumber(limit)],
    });
  } catch {
    // Metrics must never affect authentication or relay availability.
  }
}

/**
 * @param {number | undefined} value
 */
function boundedNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
