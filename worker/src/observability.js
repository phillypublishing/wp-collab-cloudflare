// @ts-check
import { CORRELATION_ID_PATTERN } from "./auth.js";

const METRIC_INDEX = "wp-collab-cloudflare";
const METRIC_EVENTS = new Set([
  "configuration_invalid",
  "connection_accepted",
  "connection_authenticated",
  "connection_closed",
  "connection_error",
  "connection_opened",
  "connection_rejected",
  "connection_resource_limit",
  "resource_limit",
]);
const METRIC_STATUSES = new Set([
  "abnormal",
  "auth_unavailable",
  "authenticated",
  "byte_rate_exceeded",
  "configuration_invalid",
  "connection_limit_exceeded",
  "connection_state_limit_exceeded",
  "document_limit_exceeded",
  "expired_token",
  "going_away",
  "inactive_token",
  "invalid_claims",
  "invalid_lifetime",
  "invalid_protocol",
  "invalid_signature",
  "invalid_token",
  "internal_error",
  "malformed_yjs_message",
  "malformed_yjs_update",
  "message_limit_exceeded",
  "message_rate_exceeded",
  "missing_key_id",
  "missing_token",
  "origin_mismatch",
  "opened",
  "other_close",
  "policy_violation",
  "protocol_error",
  "rate_limit_exceeded",
  "resource_limit",
  "room_mismatch",
  "runtime_error",
  "session_timeout",
  "token_in_url",
  "unknown_key_id",
  "unknown_site",
  "update_limit_exceeded",
  "upgraded",
  "normal",
]);
const SITE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const OBJECT_TYPE_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u;
const OBJECT_ID_PATTERN = /^(?:[1-9][0-9]{0,19}|collection)$/u;
const ROOM_PATTERN =
  /^v1\.[A-Za-z0-9_-]{16,64}\.[1-9][0-9]{0,19}\.[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,256}$/u;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SETUP_STAGES = new Set([
  "authenticated_route",
  "room_load",
  "legacy_storage_cleanup",
  "connect_handler",
  "alarm_read",
  "alarm_write",
  "relay_connect",
]);
const SETUP_STATUSES = new Set(["started", "completed", "failed"]);

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
 * Return an opaque server-owned correlation ID. PartyServer accepts a client
 * `_pk` value as its connection ID, so that identifier is not safe as an
 * Analytics Engine sampling index.
 *
 * @returns {string}
 */
export function createConnectionTelemetryId() {
  return crypto.randomUUID();
}

/**
 * @typedef {{
 *   siteId: string,
 *   blogId: string,
 *   objectType: string,
 *   objectId: string,
 *   userId: string,
 *   room: string,
 *   connectionId: string,
 *   editorSessionId?: string,
 *   connectionAttemptId?: string
 * }} ConnectionLifecycleContext
 */

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {ConnectionLifecycleContext} context
 */
export function recordConnectionAuthenticated(dataset, context) {
  recordConnectionLifecycle(
    dataset,
    "connection_authenticated",
    "authenticated",
    context,
    {}
  );
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {ConnectionLifecycleContext} context
 * @param {{ roomConnectionCount: number }} details
 */
export function recordConnectionOpened(dataset, context, details) {
  recordConnectionLifecycle(dataset, "connection_opened", "opened", context, {
    roomConnectionCount: details.roomConnectionCount,
  });
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {ConnectionLifecycleContext} context
 * @param {{ durationMilliseconds: number, roomConnectionCount: number }} details
 */
export function recordConnectionError(dataset, context, details) {
  recordConnectionLifecycle(
    dataset,
    "connection_error",
    "runtime_error",
    context,
    details
  );
}

/**
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {ConnectionLifecycleContext} context
 * @param {{
 *   closeCode: number,
 *   wasClean: boolean,
 *   durationMilliseconds: number,
 *   roomConnectionCount: number
 * }} details
 */
export function recordConnectionClosed(dataset, context, details) {
  recordConnectionLifecycle(
    dataset,
    "connection_closed",
    closeStatus(details.closeCode),
    context,
    details
  );
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
 * @typedef {{
 *   messagesInWindow?: number,
 *   bytesInWindow?: number,
 *   windowElapsedMilliseconds?: number,
 *   windowMilliseconds?: number
 * }} RateLimitDiagnostics
 */

/**
 * Keep this distinct from the aggregate resource_limit event so existing
 * pressure queries count each rejection once. Context must come from the
 * verified connection attachment, never from a message or caller-selected ID.
 *
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {ConnectionLifecycleContext} context
 * @param {string} status
 * @param {RateLimitDiagnostics & { observed?: number, limit?: number }} details
 */
export function recordConnectionResourceLimit(dataset, context, status, details) {
  recordConnectionLifecycle(dataset, "connection_resource_limit", status, context, details);
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
 * Emit attributable connection telemetry using only verified, bounded fields.
 * Raw errors and close reasons are deliberately excluded because clients can
 * supply arbitrary text in both places.
 *
 * @param {AnalyticsEngineDataset | undefined} dataset
 * @param {string} event
 * @param {string} status
 * @param {ConnectionLifecycleContext} context
 * @param {RateLimitDiagnostics & {
 *   observed?: number,
 *   limit?: number,
 *   closeCode?: number,
 *   durationMilliseconds?: number,
 *   wasClean?: boolean,
 *   roomConnectionCount?: number
 * }} details
 */
function recordConnectionLifecycle(dataset, event, status, context, details) {
  const safeContext = boundedLifecycleContext(context);
  const safeEvent = METRIC_EVENTS.has(event) ? event : "unknown";
  const safeStatus = METRIC_STATUSES.has(status) ? status : "unknown";
  const closeCode = boundedNumber(details.closeCode);
  const durationMilliseconds = boundedNumber(details.durationMilliseconds);
  const roomConnectionCount = boundedNumber(details.roomConnectionCount);
  const wasClean = details.wasClean === true;
  const resourceDetails = event === "connection_resource_limit" ? {
    observed: boundedNumber(details.observed),
    limit: boundedNumber(details.limit),
    messagesInWindow: boundedNumber(details.messagesInWindow),
    bytesInWindow: boundedNumber(details.bytesInWindow),
    windowElapsedMilliseconds: boundedNumber(details.windowElapsedMilliseconds),
    windowMilliseconds: boundedNumber(details.windowMilliseconds),
  } : undefined;

  const logFields = {
    service: "wp-collab-cloudflare",
    event: safeEvent,
    status: safeStatus,
    ...safeContext,
    durationMilliseconds,
    ...(closeCode > 0 ? { closeCode } : {}),
    ...(details.wasClean === undefined ? {} : { wasClean }),
    roomConnectionCount,
    ...resourceDetails,
  };
  try {
    console.warn(JSON.stringify(logFields));
  } catch {
    // Operational logs must never affect relay availability.
  }

  if (!dataset) {
    return;
  }
  try {
    dataset.writeDataPoint({
      indexes: [
        safeContext.connectionId === "unknown"
          ? METRIC_INDEX
          : safeContext.connectionId,
      ],
      blobs: [
        safeEvent,
        safeStatus,
        safeContext.siteId,
        safeContext.blogId,
        safeContext.objectType,
        safeContext.objectId,
        safeContext.userId,
        safeContext.room,
        safeContext.connectionId,
        // Append optional browser correlation: existing blob1-9 and doubles
        // retain their meanings. Neither browser ID becomes a sampling index.
        ...(safeContext.editorSessionId !== undefined || safeContext.connectionAttemptId !== undefined
          ? [safeContext.editorSessionId || "unknown", safeContext.connectionAttemptId || "unknown"]
          : []),
      ],
      doubles: [
        1,
        resourceDetails?.observed || 0,
        resourceDetails?.limit || 0,
        closeCode,
        durationMilliseconds,
        wasClean ? 1 : 0,
        roomConnectionCount,
        // Append traffic diagnostics; double1-7 retain their meanings.
        ...(resourceDetails ? [
          resourceDetails.messagesInWindow,
          resourceDetails.bytesInWindow,
          resourceDetails.windowElapsedMilliseconds,
          resourceDetails.windowMilliseconds,
        ] : []),
      ],
    });
  } catch {
    // Metrics must never affect authentication or relay availability.
  }
}

/**
 * @param {Partial<ConnectionLifecycleContext>} context
 * @returns {ConnectionLifecycleContext}
 */
function boundedLifecycleContext(context) {
  return {
    siteId: boundedString(context?.siteId, SITE_PATTERN),
    blogId: boundedString(context?.blogId, NUMERIC_ID_PATTERN),
    objectType:
      typeof context?.objectType === "string" &&
      context.objectType.length <= 128 &&
      OBJECT_TYPE_PATTERN.test(context.objectType)
        ? context.objectType
        : "unknown",
    objectId: boundedString(context?.objectId, OBJECT_ID_PATTERN),
    userId: boundedString(context?.userId, NUMERIC_ID_PATTERN),
    room: boundedString(context?.room, ROOM_PATTERN),
    connectionId: boundedString(context?.connectionId, CONNECTION_ID_PATTERN),
    ...(context?.editorSessionId === undefined ? {} : {
      editorSessionId: boundedString(context.editorSessionId, CORRELATION_ID_PATTERN),
    }),
    ...(context?.connectionAttemptId === undefined ? {} : {
      connectionAttemptId: boundedString(context.connectionAttemptId, CORRELATION_ID_PATTERN),
    }),
  };
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {string}
 */
function boundedString(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : "unknown";
}

/**
 * @param {number} code
 * @returns {string}
 */
function closeStatus(code) {
  return (
    {
      1000: "normal",
      1001: "going_away",
      1002: "protocol_error",
      1006: "abnormal",
      1008: "policy_violation",
      1011: "internal_error",
      4001: "session_timeout",
      4008: "resource_limit",
    }[code] || "other_close"
  );
}

/**
 * @param {number | undefined} value
 */
function boundedNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}


/**
 * Setup spans are operational logs only; they do not multiply lifecycle counts
 * in Analytics Engine. Fixed stages/statuses and bounded context exclude raw
 * errors, request headers, credentials, close reasons, and document content.
 * onLoad runs before onConnect and can only supply the room, not an authenticated
 * user or connection. A platform reset may leave a started span without an end.
 *
 * @param {Partial<ConnectionLifecycleContext>} context
 * @param {string} stage
 * @param {string} status
 * @param {number} [durationMilliseconds]
 */
export function recordSetupMilestone(context, stage, status, durationMilliseconds = 0) {
  try {
    console.warn(JSON.stringify({
      service: "wp-collab-cloudflare",
      event: "connection_setup",
      stage: SETUP_STAGES.has(stage) ? stage : "unknown",
      status: SETUP_STATUSES.has(status) ? status : "unknown",
      ...boundedLifecycleContext(context),
      durationMilliseconds: boundedNumber(durationMilliseconds),
    }));
  } catch {
    // Instrumentation must not affect the operation being diagnosed.
  }
}

/**
 * Measure one existing operation, preserving its result or original exception.
 * There are no additional network calls, storage writes, or timers.
 *
 * @template T
 * @param {Partial<ConnectionLifecycleContext>} context
 * @param {string} stage
 * @param {() => T | PromiseLike<T>} operation
 * @returns {Promise<T>}
 */
export async function observeSetupOperation(context, stage, operation) {
  const startedAt = Date.now();
  recordSetupMilestone(context, stage, "started");
  try {
    const result = await operation();
    recordSetupMilestone(context, stage, "completed", Date.now() - startedAt);
    return result;
  } catch (error) {
    recordSetupMilestone(context, stage, "failed", Date.now() - startedAt);
    throw error;
  }
}
