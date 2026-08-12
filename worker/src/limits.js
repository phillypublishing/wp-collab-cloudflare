// @ts-check

const DEFAULT_LIMITS = Object.freeze({
  maxConnectionsPerRoom: 20,
  maxMessageBytes: 1_572_864,
  maxUpdateBytes: 1_500_000,
  maxDocumentBytes: 1_500_000,
  rateWindowMilliseconds: 10_000,
  maxMessagesPerWindow: 200,
  maxBytesPerWindow: 4_194_304,
});

const LIMIT_DEFINITIONS = Object.freeze({
  COLLAB_MAX_CONNECTIONS_PER_ROOM: [1, 100],
  COLLAB_MAX_MESSAGE_BYTES: [1_024, 4_194_304],
  COLLAB_MAX_UPDATE_BYTES: [1_024, 2_000_000],
  COLLAB_MAX_DOCUMENT_BYTES: [65_536, 1_900_000],
  COLLAB_RATE_WINDOW_SECONDS: [1, 60],
  COLLAB_MAX_MESSAGES_PER_WINDOW: [10, 2_000],
  COLLAB_MAX_BYTES_PER_WINDOW: [65_536, 32_000_000],
});

// Two one-byte protocol tags plus the parser's maximum eight-byte varuint
// length field. Keeping the frame limit above the document limit ensures an
// accepted WordPress snapshot can hydrate an empty relay.
const MAX_YJS_SYNC_FRAME_OVERHEAD_BYTES = 10;

/**
 * @typedef {{
 *   COLLAB_MAX_CONNECTIONS_PER_ROOM?: string,
 *   COLLAB_MAX_MESSAGE_BYTES?: string,
 *   COLLAB_MAX_UPDATE_BYTES?: string,
 *   COLLAB_MAX_DOCUMENT_BYTES?: string,
 *   COLLAB_RATE_WINDOW_SECONDS?: string,
 *   COLLAB_MAX_MESSAGES_PER_WINDOW?: string,
 *   COLLAB_MAX_BYTES_PER_WINDOW?: string
 * }} ResourceLimitEnv
 */

export class ResourceLimitError extends Error {
  /**
   * @param {string} code
   */
  constructor(code) {
    super(code);
    this.name = "ResourceLimitError";
    this.code = code;
  }
}

/**
 * Parse public Worker variables into one fail-closed room policy.
 *
 * @param {ResourceLimitEnv} env
 */
export function parseResourceLimits(env) {
  const maxConnectionsPerRoom = parseBoundedInteger(
    env,
    "COLLAB_MAX_CONNECTIONS_PER_ROOM",
    DEFAULT_LIMITS.maxConnectionsPerRoom
  );
  const maxMessageBytes = parseBoundedInteger(
    env,
    "COLLAB_MAX_MESSAGE_BYTES",
    DEFAULT_LIMITS.maxMessageBytes
  );
  const maxUpdateBytes = parseBoundedInteger(
    env,
    "COLLAB_MAX_UPDATE_BYTES",
    DEFAULT_LIMITS.maxUpdateBytes
  );
  const maxDocumentBytes = parseBoundedInteger(
    env,
    "COLLAB_MAX_DOCUMENT_BYTES",
    DEFAULT_LIMITS.maxDocumentBytes
  );
  const rateWindowSeconds = parseBoundedInteger(
    env,
    "COLLAB_RATE_WINDOW_SECONDS",
    DEFAULT_LIMITS.rateWindowMilliseconds / 1_000
  );
  const maxMessagesPerWindow = parseBoundedInteger(
    env,
    "COLLAB_MAX_MESSAGES_PER_WINDOW",
    DEFAULT_LIMITS.maxMessagesPerWindow
  );
  const maxBytesPerWindow = parseBoundedInteger(
    env,
    "COLLAB_MAX_BYTES_PER_WINDOW",
    DEFAULT_LIMITS.maxBytesPerWindow
  );

  if (maxUpdateBytes > maxMessageBytes) {
    throw new Error(
      "COLLAB_MAX_UPDATE_BYTES cannot exceed COLLAB_MAX_MESSAGE_BYTES"
    );
  }
  if (
    maxMessageBytes <
    maxDocumentBytes + MAX_YJS_SYNC_FRAME_OVERHEAD_BYTES
  ) {
    throw new Error(
      "COLLAB_MAX_MESSAGE_BYTES must allow Yjs framing above COLLAB_MAX_DOCUMENT_BYTES"
    );
  }
  if (maxUpdateBytes !== maxDocumentBytes) {
    throw new Error(
      "COLLAB_MAX_UPDATE_BYTES must equal COLLAB_MAX_DOCUMENT_BYTES for ephemeral relay hydration"
    );
  }
  if (maxBytesPerWindow < maxMessageBytes) {
    throw new Error(
      "COLLAB_MAX_BYTES_PER_WINDOW cannot be smaller than COLLAB_MAX_MESSAGE_BYTES"
    );
  }

  return Object.freeze({
    maxConnectionsPerRoom,
    maxMessageBytes,
    maxUpdateBytes,
    maxDocumentBytes,
    rateWindowMilliseconds: rateWindowSeconds * 1_000,
    maxMessagesPerWindow,
    maxBytesPerWindow,
  });
}

/**
 * @param {ResourceLimitEnv} env
 * @param {keyof typeof LIMIT_DEFINITIONS} name
 * @param {number} fallback
 */
function parseBoundedInteger(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a decimal integer`);
  }
  const parsed = Number(value);
  const [minimum, maximum] = LIMIT_DEFINITIONS[name];
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * @param {ArrayBuffer | ArrayBufferView | string} message
 */
export function messageByteLength(message) {
  if (typeof message === "string") {
    return new TextEncoder().encode(message).byteLength;
  }
  return message.byteLength;
}

/**
 * Return the update embedded in a Yjs sync step-two/update message. Other
 * protocol messages return null. Malformed update frames fail closed before
 * they reach Yjs.
 *
 * @param {ArrayBuffer | ArrayBufferView | string} message
 * @returns {Uint8Array | null}
 */
export function getYjsUpdate(message) {
  if (typeof message === "string") {
    return null;
  }
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  const cursor = { offset: 0 };
  const messageType = readVarUint(bytes, cursor);
  if (messageType !== 0) {
    return null;
  }
  const syncType = readVarUint(bytes, cursor);
  if (syncType !== 1 && syncType !== 2) {
    return null;
  }
  const updateLength = readVarUint(bytes, cursor);
  if (cursor.offset + updateLength !== bytes.byteLength) {
    throw new ResourceLimitError("malformed_yjs_message");
  }
  return bytes.slice(cursor.offset, cursor.offset + updateLength);
}

/**
 * @param {Uint8Array} bytes
 * @param {{ offset: number }} cursor
 */
function readVarUint(bytes, cursor) {
  let value = 0;
  let multiplier = 1;
  for (let count = 0; count < 8; count += 1) {
    if (cursor.offset >= bytes.byteLength) {
      throw new ResourceLimitError("malformed_yjs_message");
    }
    const byte = bytes[cursor.offset];
    cursor.offset += 1;
    value += (byte & 127) * multiplier;
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new ResourceLimitError("malformed_yjs_message");
    }
    if ((byte & 128) === 0) {
      return value;
    }
    multiplier *= 128;
  }
  throw new ResourceLimitError("malformed_yjs_message");
}

/**
 * @param {{ windowStartedAt: number, messagesInWindow: number, bytesInWindow: number } | null | undefined} previous
 * @param {ReturnType<typeof parseResourceLimits>} limits
 * @param {number} messageBytes
 * @param {number} nowMilliseconds
 */
export function consumeMessageBudget(
  previous,
  limits,
  messageBytes,
  nowMilliseconds = Date.now()
) {
  const state =
    !previous ||
    !Number.isSafeInteger(previous.windowStartedAt) ||
    nowMilliseconds - previous.windowStartedAt >= limits.rateWindowMilliseconds ||
    nowMilliseconds < previous.windowStartedAt
      ? {
          windowStartedAt: nowMilliseconds,
          messagesInWindow: 0,
          bytesInWindow: 0,
        }
      : { ...previous };

  state.messagesInWindow += 1;
  state.bytesInWindow += messageBytes;
  if (state.messagesInWindow > limits.maxMessagesPerWindow) {
    return { allowed: false, reason: "message_rate_exceeded", state };
  }
  if (state.bytesInWindow > limits.maxBytesPerWindow) {
    return { allowed: false, reason: "byte_rate_exceeded", state };
  }
  return { allowed: true, state };
}

/**
 * PartyServer has accepted the candidate before `onConnect`, so the count
 * passed here includes it.
 *
 * @param {number} connectionCountIncludingCandidate
 * @param {ReturnType<typeof parseResourceLimits>} limits
 */
export function hasConnectionCapacity(
  connectionCountIncludingCandidate,
  limits
) {
  return connectionCountIncludingCandidate <= limits.maxConnectionsPerRoom;
}

/**
 * Persist a hibernating WebSocket attachment without allowing Cloudflare's
 * 2KB attachment ceiling to turn an ordinary message into an uncaught error.
 *
 * @param {{ setState: (updater: (state: Record<string, unknown> | null) => Record<string, unknown>) => void }} connection
 * @param {(state: Record<string, unknown> | null) => Record<string, unknown>} updater
 */
export function trySetConnectionState(connection, updater) {
  try {
    connection.setState(updater);
    return true;
  } catch {
    return false;
  }
}
