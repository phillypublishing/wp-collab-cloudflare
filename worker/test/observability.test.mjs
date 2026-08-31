import assert from "node:assert/strict";
import test from "node:test";

import {
  createConnectionTelemetryId,
  recordConfigurationInvalid,
  recordConnectionAccepted,
  recordConnectionAuthenticated,
  recordConnectionClosed,
  recordConnectionError,
  recordConnectionOpened,
  recordConnectionRejected,
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
