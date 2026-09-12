import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { awarenessOwners, handleAwarenessMessage, isAwarenessMessage, prepareAwarenessDeparture, rememberAwarenessClocks } from "../src/awareness.js";

function connection(id, ids = [], savedClocks = {}) {
  return {
    id,
    state: { __ypsAwarenessIds: ids, __wpCollabAwarenessClocks: savedClocks, identity: "preserved" },
    writes: 0,
    setState(updater) { this.state = updater(this.state); this.writes += 1; },
    close(code, reason) { this.closed = { code, reason }; },
  };
}

function presence(t) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  t.after(() => { awareness.destroy(); doc.destroy(); });
  return awareness;
}

test("forwarding after wake preserves original ownership and the latest clock", t => {
  const awareness = presence(t);
  const reporter = connection("reporter", [10], { 10: 3 });
  const agent = connection("agent", [20], { 20: 7 });
  const owners = awarenessOwners([reporter, agent]);
  // Native handler sees missing states as added, attributing both to sender.
  reporter.state.__ypsAwarenessIds = [10, 20];
  awareness.meta.set(20, { clock: 9, lastUpdated: Date.now() });
  const accepted = { senderId: reporter.id, ids: [10, 20] };
  rememberAwarenessClocks([reporter, agent], owners, awareness, accepted);
  assert.deepEqual(reporter.state.__ypsAwarenessIds, [10]);
  assert.deepEqual(agent.state.__wpCollabAwarenessClocks, { 20: 9 });
  assert.equal(agent.state.identity, "preserved");
  rememberAwarenessClocks([reporter, agent], owners, awareness, accepted);
  assert.equal(agent.writes, 1, "unchanged metadata is not rewritten");
});

test("wake departure emits a native clocked null without touching other participants", t => {
  const server = presence(t);
  const client = presence(t);
  const id = client.clientID;
  for (let clock = 0; clock < 8; clock += 1) client.setLocalState({ user: "agent" });
  const clock = client.meta.get(id).clock;
  const owner = connection("agent", [id], { [id]: clock });
  server.states.set(42, { user: "human" });
  server.meta.set(42, { clock: 4, lastUpdated: Date.now() });
  let emitted;
  server.on("update", ({ removed }) => { emitted = encodeAwarenessUpdate(server, removed); });
  prepareAwarenessDeparture(owner, server);
  removeAwarenessStates(server, [id], null);
  assert.ok(emitted, "absent volatile state still produces a departure");
  assert.deepEqual(server.states.get(42), { user: "human" });
  // A live native client with this same ID responds to its own null by bumping
  // its clock, so an overlapping reconnect can reassert its current presence.
  applyAwarenessUpdate(client, emitted, "server");
  assert.deepEqual(client.getLocalState(), { user: "agent" });
  assert.equal(client.meta.get(id).clock, clock + 1);
  applyAwarenessUpdate(server, encodeAwarenessUpdate(client, [id]), "reconnected");
  assert.deepEqual(server.states.get(id), { user: "agent" });
});

test("newer volatile states and existing departure tombstones are not overwritten", t => {
  const server = presence(t);
  const owner = connection("agent", [10, 20], { 10: 3, 20: 3 });
  server.states.set(10, { user: "agent" });
  server.meta.set(10, { clock: 7, lastUpdated: Date.now() });
  server.meta.set(20, { clock: 3, lastUpdated: Date.now() });
  prepareAwarenessDeparture(owner, server);
  assert.equal(server.meta.get(10).clock, 7);
  assert.deepEqual(server.states.get(10), { user: "agent" });
  assert.equal(server.states.has(20), false);
});

test("stale post-wake state uses the newer saved departure clock", t => {
  const server = presence(t);
  const observer = presence(t);
  const owner = connection("agent", [10], { 10: 9 });
  server.states.set(10, { user: "agent" });
  server.meta.set(10, { clock: 7, lastUpdated: Date.now() });
  observer.states.set(10, { user: "agent" });
  observer.meta.set(10, { clock: 9, lastUpdated: Date.now() });
  server.on("update", ({ removed }) => {
    applyAwarenessUpdate(observer, encodeAwarenessUpdate(server, removed), "server");
  });
  prepareAwarenessDeparture(owner, server);
  removeAwarenessStates(server, [10], null);
  assert.equal(observer.states.has(10), false);
});

test("legacy attachments without clocks retain native close behavior", t => {
  const server = presence(t);
  const owner = connection("legacy", [10]);
  delete owner.state.__wpCollabAwarenessClocks;
  prepareAwarenessDeparture(owner, server);
  assert.equal(server.states.has(10), false);
});

test("attachment failure reports the affected session without closing bystanders", t => {
  const server = presence(t);
  const owner = connection("agent", [10]);
  owner.setState = () => { throw new Error("attachment exceeds runtime limit"); };
  server.meta.set(10, { clock: 5, lastUpdated: Date.now() });
  const sender = connection("reporter", [20], { 20: 1 });
  const failed = rememberAwarenessClocks([owner, sender], awarenessOwners([owner, sender]),
    server, { senderId: sender.id, ids: [] });
  assert.deepEqual(failed, [owner]);
  assert.equal(owner.closed, undefined);
  assert.equal(sender.closed, undefined);
});

test("overlapping reconnect reclaims an updated ID after the old socket leaves", t => {
  const server = presence(t);
  const old = connection("old", [10], { 10: 4 });
  const replacement = connection("replacement");
  const nativeApply = clock => {
    const update = presence(t);
    update.states.set(10, { user: "agent" });
    update.meta.set(10, { clock, lastUpdated: Date.now() });
    // Mirror the pinned native listener's added-only attachment tracking.
    const listener = ({ added }, sender) => {
      sender.state.__ypsAwarenessIds = [...new Set([...sender.state.__ypsAwarenessIds, ...added])];
    };
    server.on("update", listener);
    try { applyAwarenessUpdate(server, encodeAwarenessUpdate(update, [10]), replacement); }
    finally { server.off("update", listener); }
  };
  handleAwarenessMessage(replacement, [old, replacement], server, () => nativeApply(5));
  assert.deepEqual(replacement.state.__ypsAwarenessIds, []);
  prepareAwarenessDeparture(old, server);
  removeAwarenessStates(server, [10], null);
  handleAwarenessMessage(replacement, [replacement], server, () => nativeApply(6));
  assert.deepEqual(replacement.state.__ypsAwarenessIds, [10]);
  prepareAwarenessDeparture(replacement, server);
  removeAwarenessStates(server, replacement.state.__ypsAwarenessIds, null);
  assert.equal(server.states.has(10), false);
});

test("unreadable attachments do not abort native departure cleanup", t => {
  const server = presence(t);
  const socket = { get state() { throw new Error("missing attachment"); } };
  assert.doesNotThrow(() => prepareAwarenessDeparture(socket, server));
});

test("awareness frame detection respects binary view offsets", () => {
  assert.equal(isAwarenessMessage("1"), false);
  assert.equal(isAwarenessMessage(new Uint8Array()), false);
  assert.equal(isAwarenessMessage(new Uint8Array([0, 1])), false);
  assert.equal(isAwarenessMessage(new Uint8Array([1]).buffer), true);
  assert.equal(isAwarenessMessage(new Uint8Array([0, 1, 0]).subarray(1, 2)), true);
});
