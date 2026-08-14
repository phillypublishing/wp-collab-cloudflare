// @ts-check

const AUDIENCE = "wp-collab-cloudflare";
const MAX_TOKEN_AGE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 4096;
const AUTH_PROTOCOL_PREFIX = "wp-collab-token.";
export const SAFE_PROTOCOL = "wp-collab-v1";
export const AUTH_EXPIRY_HEADER = "X-WP-Collab-Auth-Expires";
const SITE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const ROOM_PATTERN = /^v1\.([A-Za-z0-9_-]{16,64})\.([1-9][0-9]*)\.[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,256}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export class AuthError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   */
  constructor(status, code) {
    super(code);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Parse the site-specific HMAC keyring supplied through a Worker secret.
 *
 * @param {string | undefined} serialized
 * Legacy entries remain strings. Rotating entries use
 * `{ legacy?: string, keys: { [keyId]: string } }`, allowing a deployment to
 * accept old key-id-less credentials while WordPress switches to a named key.
 *
 * @returns {Record<string, string | { legacy?: string, keys: Record<string, string> }>}
 */
export function parseAuthKeys(serialized) {
  let parsed;
  try {
    parsed = JSON.parse(serialized || "");
  } catch {
    throw new Error("COLLAB_AUTH_KEYS must be valid JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("COLLAB_AUTH_KEYS must be a JSON object");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 100) {
    throw new Error("COLLAB_AUTH_KEYS must contain between 1 and 100 sites");
  }

  /** @type {Record<string, string | { legacy?: string, keys: Record<string, string> }>} */
  const keys = Object.create(null);
  for (const [site, configuredKeys] of entries) {
    if (!SITE_PATTERN.test(site)) {
      throw new Error("COLLAB_AUTH_KEYS contains an invalid site identifier");
    }

    if (typeof configuredKeys === "string") {
      assertValidSecret(configuredKeys);
      keys[site] = configuredKeys;
      continue;
    }

    if (!isRecord(configuredKeys)) {
      throw new Error(
        "COLLAB_AUTH_KEYS secrets must be 32-128 base64url characters (at least 32 characters)"
      );
    }
    for (const property of Object.keys(configuredKeys)) {
      if (property !== "legacy" && property !== "keys") {
        throw new Error(
          "COLLAB_AUTH_KEYS rotating entries contain an unsupported property"
        );
      }
    }

    if (!isRecord(configuredKeys.keys)) {
      throw new Error(
        "COLLAB_AUTH_KEYS rotating entries must contain verification keys"
      );
    }
    const keyEntries = Object.entries(configuredKeys.keys);
    if (keyEntries.length === 0 || keyEntries.length > 5) {
      throw new Error(
        "COLLAB_AUTH_KEYS rotating entries must contain at least one verification key and at most five"
      );
    }

    /** @type {Record<string, string>} */
    const keyedSecrets = Object.create(null);
    for (const [keyId, secret] of keyEntries) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new Error("COLLAB_AUTH_KEYS contains an invalid key identifier");
      }
      keyedSecrets[keyId] = validatedSecret(secret);
    }
    const legacySecret =
      configuredKeys.legacy === undefined
        ? undefined
        : validatedSecret(configuredKeys.legacy);
    keys[site] = {
      ...(legacySecret === undefined ? {} : { legacy: legacySecret }),
      keys: keyedSecrets,
    };
  }

  return keys;
}

/**
 * @param {unknown} secret
 */
function assertValidSecret(secret) {
  if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) {
    throw new Error(
      "COLLAB_AUTH_KEYS secrets must be 32-128 base64url characters (at least 32 characters)"
    );
  }
}

/**
 * @param {unknown} secret
 * @returns {string}
 */
function validatedSecret(secret) {
  assertValidSecret(secret);
  return /** @type {string} */ (secret);
}

/**
 * Read the short-lived credential from a browser-compatible WebSocket
 * subprotocol. Credentials in the URL are rejected so they cannot enter
 * request-URL logs or histories.
 *
 * @param {Request} request
 * @returns {string}
 */
function connectionToken(request) {
  if (new URL(request.url).searchParams.has("token")) {
    throw new AuthError(400, "token_in_url");
  }

  const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  const credentials = protocols.filter((protocol) =>
    protocol.startsWith(AUTH_PROTOCOL_PREFIX)
  );
  if (credentials.length === 0) {
    throw new AuthError(401, "missing_token");
  }
  if (credentials.length !== 1) {
    throw new AuthError(401, "invalid_token");
  }
  if (
    !protocols.includes(SAFE_PROTOCOL) ||
    protocols.some(
      (protocol) =>
        protocol !== SAFE_PROTOCOL &&
        !protocol.startsWith(AUTH_PROTOCOL_PREFIX)
    )
  ) {
    throw new AuthError(400, "invalid_protocol");
  }
  return credentials[0].slice(AUTH_PROTOCOL_PREFIX.length);
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AuthError(401, "invalid_token");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("non-canonical origin");
    }
    return url.origin;
  } catch {
    throw new AuthError(403, "origin_mismatch");
  }
}

/**
 * Verify a short-lived WordPress-issued credential before a WebSocket upgrade.
 *
 * @param {{
 *   request: Request,
 *   room: string,
 *   authKeys: Record<string, string | CryptoKey | Promise<CryptoKey> | {
 *     legacy?: string | CryptoKey | Promise<CryptoKey>,
 *     keys: Record<string, string | CryptoKey | Promise<CryptoKey>>
 *   }>,
 *   nowSeconds?: number
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function verifyConnectionRequest({
  request,
  room,
  authKeys,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const token = connectionToken(request);
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new AuthError(401, "invalid_token");
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AuthError(401, "invalid_token");
  }

  let claims;
  try {
    claims = JSON.parse(textDecoder.decode(base64UrlDecode(parts[0])));
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(401, "invalid_token");
  }
  if (!isRecord(claims) || typeof claims.site !== "string") {
    throw new AuthError(401, "invalid_token");
  }

  if (!SITE_PATTERN.test(claims.site)) {
    throw new AuthError(401, "invalid_claims");
  }

  if (!Object.hasOwn(authKeys, claims.site)) {
    throw new AuthError(401, "unknown_site");
  }
  const configuredKeys = authKeys[claims.site];
  /** @type {string | undefined} */
  let keyId;
  if (Object.hasOwn(claims, "kid")) {
    if (typeof claims.kid !== "string" || !KEY_ID_PATTERN.test(claims.kid)) {
      throw new AuthError(401, "invalid_claims");
    }
    keyId = claims.kid;
  }

  let authKey;
  if (
    typeof configuredKeys === "string" ||
    configuredKeys instanceof CryptoKey ||
    configuredKeys instanceof Promise
  ) {
    if (keyId !== undefined) {
      throw new AuthError(401, "unknown_key_id");
    }
    authKey = configuredKeys;
  } else if (keyId !== undefined) {
    if (!Object.hasOwn(configuredKeys.keys, keyId)) {
      throw new AuthError(401, "unknown_key_id");
    }
    authKey = configuredKeys.keys[keyId];
  } else {
    if (configuredKeys.legacy === undefined) {
      throw new AuthError(401, "missing_key_id");
    }
    authKey = configuredKeys.legacy;
  }

  let signature;
  try {
    signature = base64UrlDecode(parts[1]);
  } catch {
    throw new AuthError(401, "invalid_token");
  }
  const key = await importVerificationKey(authKey);
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    textEncoder.encode(parts[0])
  );
  if (!validSignature) {
    throw new AuthError(401, "invalid_signature");
  }

  const { aud, blog, exp, iat, nbf, origin, site, sub, v } = claims;
  if (
    v !== 1 ||
    aud !== AUDIENCE ||
    typeof blog !== "string" ||
    !/^[1-9][0-9]*$/u.test(blog) ||
    typeof sub !== "string" ||
    !sub ||
    typeof iat !== "number" ||
    typeof nbf !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(nbf) ||
    !Number.isSafeInteger(exp) ||
    typeof claims.room !== "string" ||
    typeof origin !== "string"
  ) {
    throw new AuthError(401, "invalid_claims");
  }
  if (exp <= nowSeconds) {
    throw new AuthError(401, "expired_token");
  }
  if (nbf > nowSeconds + CLOCK_SKEW_SECONDS || iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new AuthError(401, "inactive_token");
  }
  if (exp <= iat || exp - iat > MAX_TOKEN_AGE_SECONDS) {
    throw new AuthError(401, "invalid_lifetime");
  }

  const roomMatch = ROOM_PATTERN.exec(room);
  if (
    !roomMatch ||
    roomMatch[1] !== site ||
    roomMatch[2] !== blog ||
    claims.room !== room
  ) {
    throw new AuthError(403, "room_mismatch");
  }

  const expectedOrigin = canonicalOrigin(origin);
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin || canonicalOrigin(requestOrigin) !== expectedOrigin) {
    throw new AuthError(403, "origin_mismatch");
  }

  return claims;
}

/**
 * @param {string | CryptoKey | Promise<CryptoKey>} authKey
 * @returns {Promise<CryptoKey>}
 */
async function importVerificationKey(authKey) {
  if (typeof authKey !== "string") {
    return await authKey;
  }
  return await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(authKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/**
 * Remove the credential-bearing subprotocol before PartyServer receives the
 * request, and attach only the verified grant expiry so the Durable Object can
 * reject an upgrade that expired in transit. Established-session lifetime is
 * configured independently by the Durable Object.
 *
 * @param {Request} request
 * @param {number} expiresAtSeconds
 * @returns {Request}
 */
export function sanitizeAuthenticatedRequest(request, expiresAtSeconds) {
  const headers = new Headers(request.headers);
  const protocols = (headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(
      (protocol) => protocol && !protocol.startsWith(AUTH_PROTOCOL_PREFIX)
    );
  if (protocols.length) {
    headers.set("Sec-WebSocket-Protocol", protocols.join(", "));
  } else {
    headers.delete("Sec-WebSocket-Protocol");
  }
  headers.set(AUTH_EXPIRY_HEADER, String(expiresAtSeconds));
  return new Request(request, { headers });
}

/**
 * Compute how long the verified connection grant remains valid during the
 * upgrade. A missing or invalid internal expiry fails closed immediately.
 *
 * @param {Request} request
 * @param {number} [nowMilliseconds]
 * @returns {number}
 */
export function getAuthExpiryDelay(
  request,
  nowMilliseconds = Date.now()
) {
  const expiresAtSeconds = Number(request.headers.get(AUTH_EXPIRY_HEADER));
  if (!Number.isSafeInteger(expiresAtSeconds)) {
    return 0;
  }
  return Math.max(0, expiresAtSeconds * 1000 - nowMilliseconds);
}

/**
 * Refuse HTTP room requests before PartyServer can resolve or initialize a
 * Durable Object. Health checks and unknown routes continue to the router.
 *
 * @template T
 * @param {Request} request
 * @param {() => Promise<T>} routeRequest
 * @returns {Promise<Response | T>}
 */
export async function routeAfterWebSocketGuard(request, routeRequest) {
  // Match PartyServer's own segment parsing exactly. It ignores empty and
  // trailing/suffix segments when resolving the namespace and room, so an
  // exact-path regular expression would leave alternate routed shapes open.
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const isRoomRequest =
    parts.length >= 3 &&
    parts[0] === "parties" &&
    parts[1] === "collaboration" &&
    Boolean(parts[2]);
  const isWebSocket =
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (isRoomRequest && !isWebSocket) {
    return new Response("WebSocket upgrade required", {
      status: 426,
      headers: {
        "Cache-Control": "no-store",
        Upgrade: "websocket",
      },
    });
  }
  return routeRequest();
}
