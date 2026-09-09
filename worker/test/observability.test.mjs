import assert from "node:assert/strict";
import test from "node:test";

import {
  createConnectionTelemetryId,
  recordSetupMilestone,
  observeSetupOperation,
  recordConfigurationInvalid,
  recordConnectionAccepted,
  recordConnectionAuthenticated,
  recordConnectionClosed,
  recordConnectionError,
  recordConnectionOpened,
  recordConnectionRejected,
  recordConnectionResourceLimit,
  recordResourceLimit,
} from "../src/observability.js";

function recordingDataset() {
  const points = [];
  return {
    points,
    writeDataPoint(point) {
      points.push(point);
    },
  };
}

test("connection lifecycle correlation IDs are server-owned UUIDs", () => {
  const callerSelectedPartyServerId = "attacker-controlled-pk";
  const first = createConnectionTelemetryId();
  const second = createConnectionTelemetryId();

  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  assert.notEqual(first, callerSelectedPartyServerId);
  assert.notEqual(first, second);
});

const lifecycleContext = {
  siteId: "0123456789abcdef0123456789abcdef",
  blogId: "1",
  objectType: "postType/post",
  objectId: "305806",
  userId: "7",
  room: "v1.0123456789abcdef0123456789abcdef.1.cG9zdFR5cGUvcG9zdA.MzA1ODA2",
  connectionId: "connection_abc123",
};

test("resource-limit diagnostics correlate the rejected window without changing aggregate counts", () => {
  const dataset = recordingDataset();
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(JSON.parse(message));
  const context = {
    ...lifecycleContext,
    editorSessionId: "01234567-89ab-4def-8123-456789abcdef",
    connectionAttemptId: "abcdef01-2345-6789-abcd-ef0123456789",
  };
  const details = {
    observed: 1001,
    limit: 1000,
    messagesInWindow: 1001,
    bytesInWindow: 64064,
    windowElapsedMilliseconds: 1250,
    windowMilliseconds: 10000,
  };
  try {
    recordResourceLimit(dataset, "message_rate_exceeded", 1001, 1000);
    recordConnectionResourceLimit(dataset, context, "message_rate_exceeded", details);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(dataset.points.filter((point) => point.blobs[0] === "resource_limit").length, 1);
  const diagnostic = dataset.points[1];
  assert.deepEqual(diagnostic.indexes, [context.connectionId]);
  assert.deepEqual(diagnostic.blobs, [
    "connection_resource_limit", "message_rate_exceeded",
    context.siteId, context.blogId, context.objectType, context.objectId,
    context.userId, context.room, context.connectionId,
    context.editorSessionId, context.connectionAttemptId,
  ]);
  assert.deepEqual(diagnostic.doubles, [1, 1001, 1000, 0, 0, 0, 0, 1001, 64064, 1250, 10000]);
  assert.deepEqual(messages, [{
    service: "wp-collab-cloudflare",
    event: "connection_resource_limit",
    status: "message_rate_exceeded",
    ...context,
    durationMilliseconds: 0,
    roomConnectionCount: 0,
    ...details,
  }]);
});

test("resource-limit diagnostics sanitize fields and tolerate unavailable logging", () => {
  const dataset = recordingDataset();
  const messages = [];
  const sensitive = "token=secret document=private-content";
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(message);
  try {
    recordConnectionResourceLimit(dataset, {
      ...lifecycleContext, userId: sensitive, connectionId: sensitive,
      editorSessionId: sensitive, connectionAttemptId: sensitive,
      document: sensitive,
    }, sensitive, {
      observed: Infinity, limit: -1, messagesInWindow: NaN,
      bytesInWindow: sensitive, windowElapsedMilliseconds: -100,
      windowMilliseconds: Infinity, document: sensitive,
    });
    assert.equal(JSON.stringify([dataset.points, messages]).includes(sensitive), false);
    assert.equal(dataset.points[0].blobs[1], "unknown");
    assert.deepEqual(dataset.points[0].doubles, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(dataset.points[0].indexes, ["wp-collab-cloudflare"]);
    console.warn = () => { throw new Error("logging unavailable"); };
    const unavailable = { writeDataPoint() { throw new Error("analytics unavailable"); } };
    for (const target of [undefined, unavailable]) {
      assert.doesNotThrow(() => recordConnectionResourceLimit(
        target, lifecycleContext, "message_rate_exceeded", { observed: 1001, limit: 1000 }
      ));
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("observability helpers write the bounded count-only schema", () => {
  const dataset = recordingDataset();

  recordConfigurationInvalid(dataset);
  recordConnectionRejected(dataset, "expired_token");
  recordConnectionAccepted(dataset);
  recordResourceLimit(dataset, "message_limit_exceeded", 1_600_000, 1_572_864);

  assert.deepEqual(dataset.points, [
    {
      indexes: ["wp-collab-cloudflare"],
      blobs: ["configuration_invalid", "configuration_invalid"],
      doubles: [1, 0, 0],
    },
    {
      indexes: ["wp-collab-cloudflare"],
      blobs: ["connection_rejected", "expired_token"],
      doubles: [1, 0, 0],
    },
    {
      indexes: ["wp-collab-cloudflare"],
      blobs: ["connection_accepted", "upgraded"],
      doubles: [1, 0, 0],
    },
    {
      indexes: ["wp-collab-cloudflare"],
      blobs: ["resource_limit", "message_limit_exceeded"],
      doubles: [1, 1_600_000, 1_572_864],
    },
  ]);
});

test("observability is optional and cannot disrupt the relay", () => {
  assert.doesNotThrow(() => recordConnectionAccepted(undefined));
  const unavailableDataset = {
    writeDataPoint() {
      throw new Error("analytics unavailable");
    },
  };
  assert.doesNotThrow(() =>
    recordConnectionRejected(unavailableDataset, "missing_token")
  );
  assert.doesNotThrow(() => recordConfigurationInvalid(unavailableDataset));
  assert.doesNotThrow(() =>
    recordResourceLimit(
      unavailableDataset,
      "message_limit_exceeded",
      1_600_000,
      1_572_864
    )
  );
});

test("connection lifecycle records retain verified incident identifiers and close details", () => {
  const dataset = recordingDataset();
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(JSON.parse(message));

  try {
    recordConnectionAuthenticated(dataset, lifecycleContext);
    recordConnectionOpened(dataset, lifecycleContext, {
      roomConnectionCount: 1,
    });
    recordConnectionError(dataset, lifecycleContext, {
      durationMilliseconds: 2_500,
      roomConnectionCount: 1,
    });
    recordConnectionClosed(dataset, lifecycleContext, {
      closeCode: 1006,
      wasClean: false,
      durationMilliseconds: 3_456,
      roomConnectionCount: 0,
    });
    recordConnectionClosed(dataset, lifecycleContext, {
      closeCode: 4008,
      wasClean: true,
      durationMilliseconds: 3_500,
      roomConnectionCount: 0,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(dataset.points, [
    {
      indexes: ["connection_abc123"],
      blobs: [
        "connection_authenticated",
        "authenticated",
        "0123456789abcdef0123456789abcdef",
        "1",
        "postType/post",
        "305806",
        "7",
        "v1.0123456789abcdef0123456789abcdef.1.cG9zdFR5cGUvcG9zdA.MzA1ODA2",
        "connection_abc123",
      ],
      doubles: [1, 0, 0, 0, 0, 0, 0],
    },
    {
      indexes: ["connection_abc123"],
      blobs: [
        "connection_opened",
        "opened",
        "0123456789abcdef0123456789abcdef",
        "1",
        "postType/post",
        "305806",
        "7",
        "v1.0123456789abcdef0123456789abcdef.1.cG9zdFR5cGUvcG9zdA.MzA1ODA2",
        "connection_abc123",
      ],
      doubles: [1, 0, 0, 0, 0, 0, 1],
    },
    {
      indexes: ["connection_abc123"],
      blobs: [
        "connection_error",
        "runtime_error",
        "0123456789abcdef0123456789abcdef",
        "1",
        "postType/post",
        "305806",
        "7",
        "v1.0123456789abcdef0123456789abcdef.1.cG9zdFR5cGUvcG9zdA.MzA1ODA2",
        "connection_abc123",
      ],
      doubles: [1, 0, 0, 0, 2_500, 0, 1],
    },
    {
      indexes: ["connection_abc123"],
      blobs: [
        "connection_closed",
        "abnormal",
        "0123456789abcdef0123456789abcdef",
        "1",
        "postType/post",
        "305806",
        "7",
        "v1.0123456789abcdef0123456789abcdef.1.cG9zdFR5cGUvcG9zdA.MzA1ODA2",
        "connection_abc123",
      ],
      doubles: [1, 0, 0, 1006, 3_456, 0, 0],
    },
    {
      indexes: ["connection_abc123"],
      blobs: [
        "connection_closed",
        "resource_limit",
        "0123456789abcdef0123456789abcdef",
        "1",
        "postType/post",
        "305806",
        "7",
        "v1.0123456789abcdef0123456789abcdef.1.cG9zdFR5cGUvcG9zdA.MzA1ODA2",
        "connection_abc123",
      ],
      doubles: [1, 0, 0, 4008, 3_500, 1, 0],
    },
  ]);
  assert.deepEqual(messages, [
    {
      service: "wp-collab-cloudflare",
      event: "connection_authenticated",
      status: "authenticated",
      ...lifecycleContext,
      durationMilliseconds: 0,
      roomConnectionCount: 0,
    },
    {
      service: "wp-collab-cloudflare",
      event: "connection_opened",
      status: "opened",
      ...lifecycleContext,
      durationMilliseconds: 0,
      roomConnectionCount: 1,
    },
    {
      service: "wp-collab-cloudflare",
      event: "connection_error",
      status: "runtime_error",
      ...lifecycleContext,
      durationMilliseconds: 2_500,
      roomConnectionCount: 1,
    },
    {
      service: "wp-collab-cloudflare",
      event: "connection_closed",
      status: "abnormal",
      ...lifecycleContext,
      closeCode: 1006,
      durationMilliseconds: 3_456,
      wasClean: false,
      roomConnectionCount: 0,
    },
    {
      service: "wp-collab-cloudflare",
      event: "connection_closed",
      status: "resource_limit",
      ...lifecycleContext,
      durationMilliseconds: 3_500,
      closeCode: 4008,
      wasClean: true,
      roomConnectionCount: 0,
    },
  ]);
});

test("observability never forwards arbitrary strings or unbounded numbers", () => {
  const dataset = recordingDataset();
  const sensitive =
    "https://wordpress.example.test/post/12?token=secret user=7 room=private";

  recordConnectionRejected(dataset, sensitive);
  recordResourceLimit(dataset, sensitive, -50, Number.POSITIVE_INFINITY);

  assert.deepEqual(dataset.points, [
    {
      indexes: ["wp-collab-cloudflare"],
      blobs: ["connection_rejected", "unknown"],
      doubles: [1, 0, 0],
    },
    {
      indexes: ["wp-collab-cloudflare"],
      blobs: ["resource_limit", "unknown"],
      doubles: [1, 0, 0],
    },
  ]);
  assert.equal(JSON.stringify(dataset.points).includes(sensitive), false);
});

test("connection lifecycle records reject unverified strings and raw error content", () => {
  const dataset = recordingDataset();
  const sensitive = "token=secret document=private-content";
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (message) => messages.push(message);

  try {
    recordConnectionClosed(
      dataset,
      {
        siteId: sensitive,
        blogId: sensitive,
        objectType: sensitive,
        objectId: sensitive,
        userId: sensitive,
        room: sensitive,
        connectionId: sensitive,
      },
      {
        closeCode: Number.POSITIVE_INFINITY,
        wasClean: false,
        durationMilliseconds: Number.POSITIVE_INFINITY,
        roomConnectionCount: Number.POSITIVE_INFINITY,
      }
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(JSON.stringify(dataset.points).includes(sensitive), false);
  assert.equal(messages.join("\n").includes(sensitive), false);
  assert.deepEqual(dataset.points[0], {
    indexes: ["wp-collab-cloudflare"],
    blobs: [
      "connection_closed",
      "other_close",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ],
    doubles: [1, 0, 0, 0, 0, 0, 0],
  });
});

test("connection lifecycle records reject overlong WordPress identifiers", () => {
  const dataset = recordingDataset();
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    recordConnectionOpened(
      dataset,
      {
        ...lifecycleContext,
        blogId: "1".repeat(21),
        objectId: "1".repeat(21),
        userId: "1".repeat(21),
      },
      { roomConnectionCount: 1 }
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(dataset.points[0].blobs.slice(2, 7), [
    lifecycleContext.siteId,
    "unknown",
    lifecycleContext.objectType,
    "unknown",
    "unknown",
  ]);
});


test("setup spans preserve operation results and failures without leaking exceptions", async (t) => {
  const messages = [];
  t.mock.method(console, "warn", (message) => messages.push(JSON.parse(message)));
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const result = await observeSetupOperation(lifecycleContext, "alarm_read", async () => {
    now += 43000;
    return 123;
  });
  assert.equal(result, 123);
  const failure = new Error("token=secret private-document");
  await assert.rejects(observeSetupOperation(lifecycleContext, "alarm_write", async () => {
    now += 20;
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(messages.map(({ stage, status, durationMilliseconds }) => ({ stage, status, durationMilliseconds })), [
    { stage: "alarm_read", status: "started", durationMilliseconds: 0 },
    { stage: "alarm_read", status: "completed", durationMilliseconds: 43000 },
    { stage: "alarm_write", status: "started", durationMilliseconds: 0 },
    { stage: "alarm_write", status: "failed", durationMilliseconds: 20 },
  ]);
  assert.equal(JSON.stringify(messages).includes(failure.message), false);
});

test("setup telemetry is bounded, works before authenticated identity, and is best effort", async (t) => {
  const messages = [];
  t.mock.method(console, "warn", (message) => messages.push(JSON.parse(message)));
  recordSetupMilestone({ room: lifecycleContext.room }, "room_load", "started", 0);
  recordSetupMilestone({ editorSessionId: "token=secret" }, "token=secret", "token=secret", Infinity);
  assert.equal(messages[0].room, lifecycleContext.room);
  assert.equal(messages[0].userId, "unknown");
  assert.equal(messages[0].connectionId, "unknown");
  assert.equal(messages[1].stage, "unknown");
  assert.equal(messages[1].status, "unknown");
  assert.equal(messages[1].durationMilliseconds, 0);
  assert.equal(JSON.stringify(messages).includes("token=secret"), false);
  t.mock.method(console, "warn", () => { throw new Error("sink failed"); });
  assert.equal(await observeSetupOperation(lifecycleContext, "relay_connect", async () => 42), 42);
});

test("signed browser correlation appends to lifecycle analytics without shifting existing columns", (t) => {
  t.mock.method(console, "warn", () => {});
  const dataset = recordingDataset();
  const correlation = {
    editorSessionId: "01234567-89ab-4def-8123-456789abcdef",
    connectionAttemptId: "ABCDEF01-2345-6789-ABCD-EF0123456789",
  };
  recordConnectionAuthenticated(dataset, { ...lifecycleContext, ...correlation });
  assert.deepEqual(dataset.points[0].blobs.slice(9), Object.values(correlation));
  assert.equal(dataset.points[0].blobs[8], lifecycleContext.connectionId);
  assert.deepEqual(dataset.points[0].indexes, [lifecycleContext.connectionId]);
});
