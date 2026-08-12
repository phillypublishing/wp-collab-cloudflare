import assert from "node:assert/strict";
import test from "node:test";

import {
  recordConfigurationInvalid,
  recordConnectionAccepted,
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

test("observability helpers write the bounded count-only schema", () => {
  const dataset = recordingDataset();

  recordConfigurationInvalid(dataset);
  recordConnectionRejected(dataset, "expired_token");
  recordConnectionAccepted(dataset);
  recordResourceLimit(
    dataset,
    "message_limit_exceeded",
    1_600_000,
    1_572_864
  );

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
