import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthError,
  getAuthExpiryDelay,
  parseAuthKeys,
  routeAfterWebSocketGuard,
  sanitizeAuthenticatedRequest,
  verifyConnectionRequest,
} from "../src/auth.js";

const encoder = new TextEncoder();
const site = "0123456789abcdef0123456789abcdef";
const otherSite = "fedcba9876543210fedcba9876543210";
const room = `v1.${site}.1.cG9zdFR5cGUvcG9zdA.MTIz`;
const origin = "https://wordpress.example.test";
const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const nowSeconds = 1_800_000_000;

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function mintToken(overrides = {}, signingSecret = secret) {
  const claims = {
    v: 1,
    aud: "wp-collab-cloudflare",
    site,
    blog: "1",
    origin,
    room,
    sub: "7",
    iat: nowSeconds,
    nbf: nowSeconds - 5,
    exp: nowSeconds + 60,
    ...overrides,
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function makeRequest(token, requestOrigin = origin, useQuery = false) {
  const url = new URL(
    `https://worker.example.test/parties/collaboration/${room}`
  );
  if (token !== null && useQuery) {
    url.searchParams.set("token", token);
  }
  const headers = requestOrigin === null ? {} : { Origin: requestOrigin };
  if (token !== null && !useQuery) {
    headers["Sec-WebSocket-Protocol"] =
      `wp-collab-v1, wp-collab-token.${token}`;
  }
  return new Request(url, {
    headers,
  });
}

async function expectAuthError(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("parseAuthKeys accepts a site-specific keyring", () => {
  const keys = parseAuthKeys(JSON.stringify({ [site]: secret }));
  assert.equal(Object.getPrototypeOf(keys), null);
  assert.equal(keys[site], secret);
});

test("parseAuthKeys accepts overlapping keyed credentials with a legacy bridge", () => {
  const nextSecret = `${secret}00`;
  const keys = parseAuthKeys(
    JSON.stringify({
      [site]: {
        legacy: secret,
        keys: {
          "2026-08": nextSecret,
          "2026-07": secret,
        },
      },
    })
  );

  assert.equal(Object.getPrototypeOf(keys[site].keys), null);
  assert.equal(keys[site].legacy, secret);
  assert.equal(keys[site].keys["2026-08"], nextSecret);
});

test("parseAuthKeys rejects malformed or weak keyrings", () => {
  assert.throws(() => parseAuthKeys("not-json"), /valid JSON/u);
  assert.throws(
    () => parseAuthKeys(JSON.stringify({ [site]: "short" })),
    /at least 32/u
  );
  assert.throws(
    () => parseAuthKeys(JSON.stringify({ "../site": secret })),
    /site identifier/u
  );
  assert.throws(
    () =>
      parseAuthKeys(
        JSON.stringify({ [site]: { keys: { "../key": secret } } })
      ),
    /key identifier/u
  );
  assert.throws(
    () => parseAuthKeys(JSON.stringify({ [site]: { keys: {} } })),
    /at least one verification key/u
  );
  assert.throws(
    () =>
      parseAuthKeys(
        JSON.stringify({ [site]: { keys: { current: secret }, extra: true } })
      ),
    /unsupported property/u
  );
});

test("accepts a valid room-scoped credential from the matching Origin", async () => {
  const token = await mintToken();
  const claims = await verifyConnectionRequest({
    request: makeRequest(token),
    room,
    authKeys: { [site]: secret },
    nowSeconds,
  });

  assert.equal(claims.site, site);
  assert.equal(claims.room, room);
  assert.equal(claims.sub, "7");
});

test("supports keyed rotation while retaining an explicit legacy bridge", async () => {
  const nextSecret = `${secret}00`;
  const authKeys = {
    [site]: {
      legacy: secret,
      keys: {
        "2026-08": nextSecret,
        "2026-07": secret,
      },
    },
  };

  const keyedClaims = await verifyConnectionRequest({
    request: makeRequest(
      await mintToken({ kid: "2026-08" }, nextSecret)
    ),
    room,
    authKeys,
    nowSeconds,
  });
  assert.equal(keyedClaims.kid, "2026-08");

  const legacyClaims = await verifyConnectionRequest({
    request: makeRequest(await mintToken()),
    room,
    authKeys,
    nowSeconds,
  });
  assert.equal(legacyClaims.kid, undefined);

  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(
        await mintToken({ kid: "retired" }, nextSecret)
      ),
      room,
      authKeys,
      nowSeconds,
    }),
    401,
    "unknown_key_id"
  );

  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(await mintToken()),
      room,
      authKeys: { [site]: { keys: { "2026-08": nextSecret } } },
      nowSeconds,
    }),
    401,
    "missing_key_id"
  );

  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(
        await mintToken({ kid: "../invalid" }, nextSecret)
      ),
      room,
      authKeys,
      nowSeconds,
    }),
    401,
    "invalid_claims"
  );
});

test("normalizes an explicit default Origin port", async () => {
  const token = await mintToken({ origin: `${origin}:443` });
  const claims = await verifyConnectionRequest({
    request: makeRequest(token),
    room,
    authKeys: { [site]: secret },
    nowSeconds,
  });

  assert.equal(claims.origin, `${origin}:443`);
});

test("rejects missing, malformed, and incorrectly signed credentials", async () => {
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(null),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "missing_token"
  );
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest("not-a-token"),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "invalid_token"
  );
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(await mintToken({}, `${secret}00`)),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "invalid_signature"
  );
});

test("rejects URL credentials before authenticating", async () => {
  const token = await mintToken();
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(token, origin, true),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    400,
    "token_in_url"
  );
});

test("rejects expired and not-yet-valid credentials", async () => {
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(await mintToken({ exp: nowSeconds - 1 })),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "expired_token"
  );
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(await mintToken({ nbf: nowSeconds + 31 })),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "inactive_token"
  );
});

test("rejects missing or mismatched Origin headers", async () => {
  const token = await mintToken();
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(token, null),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    403,
    "origin_mismatch"
  );
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(token, "https://evil.example.test"),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    403,
    "origin_mismatch"
  );
});

test("rejects room and site namespace confusion", async () => {
  const token = await mintToken();
  const otherRoom = `v1.${site}.1.cG9zdFR5cGUvcG9zdA.MTI0`;
  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(token),
      room: otherRoom,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    403,
    "room_mismatch"
  );

  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(await mintToken({ site: otherSite })),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "unknown_site"
  );

  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(token),
      room,
      authKeys: Object.create({ [site]: secret }),
      nowSeconds,
    }),
    401,
    "unknown_site"
  );

  await expectAuthError(
    verifyConnectionRequest({
      request: makeRequest(await mintToken({ site: "constructor" })),
      room,
      authKeys: { [site]: secret },
      nowSeconds,
    }),
    401,
    "invalid_claims"
  );
});

test("strips the credential header and forwards only the expiry internally", async () => {
  const request = makeRequest(await mintToken());
  const sanitized = sanitizeAuthenticatedRequest(request, nowSeconds + 60);

  assert.equal(sanitized.url, request.url);
  assert.equal(
    sanitized.headers.get("Sec-WebSocket-Protocol"),
    "wp-collab-v1"
  );
  assert.equal(
    sanitized.headers.get("X-WP-Collab-Auth-Expires"),
    String(nowSeconds + 60)
  );
  assert.equal(new URL(sanitized.url).pathname.endsWith(room), true);
});

test("rejects non-WebSocket room requests before invoking PartyServer", async () => {
  let partyRouterCalls = 0;
  const request = new Request(
    `https://worker.example.test/parties/collaboration/${room}`
  );

  const response = await routeAfterWebSocketGuard(request, async () => {
    partyRouterCalls += 1;
    throw new Error("PartyServer would initialize the Durable Object");
  });

  assert.equal(response.status, 426);
  assert.equal(response.headers.get("Upgrade"), "websocket");
  assert.equal(partyRouterCalls, 0, "the DO router/storage path was not reached");
});

test("allows a WebSocket upgrade to reach PartyServer", async () => {
  let partyRouterCalls = 0;
  const request = new Request(
    `https://worker.example.test/parties/collaboration/${room}`,
    { headers: { Upgrade: "websocket" } }
  );

  const response = await routeAfterWebSocketGuard(request, async () => {
    partyRouterCalls += 1;
    return new Response("routed", { status: 202 });
  });

  assert.equal(response.status, 202);
  assert.equal(partyRouterCalls, 1);
});

test("computes a bounded server-side connection lifetime", () => {
  const request = sanitizeAuthenticatedRequest(
    makeRequest(null),
    nowSeconds + 60
  );
  assert.equal(getAuthExpiryDelay(request, nowSeconds * 1000), 60_000);
  assert.equal(
    getAuthExpiryDelay(request, (nowSeconds + 61) * 1000),
    0
  );
});
