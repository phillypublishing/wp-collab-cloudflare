// @ts-check

import { trySetConnectionState } from "./limits.js";

// y-partyserver 2.2.0 already keeps client IDs in socket attachments. Preserve
// their protocol clocks too, not user/cursor data or Yjs document bytes.
const IDS_KEY = "__ypsAwarenessIds";
const CLOCKS_KEY = "__wpCollabAwarenessClocks";

/** @param {import("partyserver").WSMessage} message */
export function isAwarenessMessage(message) {
  if (typeof message === "string") return false;
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) :
    new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return bytes[0] === 1;
}

/** @typedef {import("partyserver").Connection<Record<string, unknown>>} Connection */
/** @typedef {import("y-protocols/awareness").Awareness} Awareness */

/** @param {Connection} connection */
function connectionState(connection) {
  // Match native getAwarenessIds: a missing attachment must not abort close.
  try { return connection.state ?? {}; } catch { return {}; }
}

/** @param {Connection} connection @returns {number[]} */
function ownedIds(connection) {
  return /** @type {number[]} */ (connectionState(connection)[IDS_KEY] ?? []);
}

/** @param {Connection} connection @returns {Record<number, number>} */
function clocks(connection) {
  return /** @type {Record<number, number>} */ (connectionState(connection)[CLOCKS_KEY] ?? {});
}

/**
 * Capture ownership before native message handling: a peer forwarding another
 * client's state after wake must not acquire that already-owned client ID.
 * @param {Iterable<Connection>} connections
 */
export function awarenessOwners(connections) {
  const owners = new Map();
  for (const connection of connections) {
    for (const id of ownedIds(connection)) owners.set(id, connection.id);
  }
  return /** @type {Map<number, string>} */ (owners);
}

/**
 * Called synchronously after native awareness handling. Store only changes,
 * including newer clocks forwarded by a different socket. Socket attachments
 * survive hibernation; in-memory awareness.meta does not.
 * @param {Iterable<Connection>} connections
 * @param {Map<number, string>} previousOwners
 * @param {Awareness} awareness
 * @param {{ senderId: string, ids: number[] }} accepted
 */
export function rememberAwarenessClocks(connections, previousOwners, awareness, accepted) {
  const failures = [];
  for (const connection of connections) {
    const previousState = connectionState(connection);
    const previousIds = ownedIds(connection);
    // Native tracking only acquires "added" IDs. A reconnect reasserts an
    // "updated" ID because its previous departure retained a clock tombstone.
    const candidates = connection.id === accepted.senderId
      ? [...new Set([...previousIds, ...accepted.ids])] : previousIds;
    const ids = candidates.filter(id =>
      !previousOwners.has(id) || previousOwners.get(id) === connection.id);
    const previousClocks = clocks(connection);
    const nextClocks = Object.fromEntries(ids.map(id => [id,
      Math.max(previousClocks[id] ?? 0, awareness.meta.get(id)?.clock ?? 0),
    ]));
    if (ids.length === previousIds.length &&
      Object.keys(previousClocks).length === ids.length &&
      ids.every(id => previousClocks[id] === nextClocks[id])) continue;
    if (!trySetConnectionState(connection, state => ({
      ...state, [IDS_KEY]: ids, [CLOCKS_KEY]: nextClocks,
    }))) {
      // PartyServer updates its cache before serialization. Restore the prior
      // attachment as well as returning failure; a sender must not eject an
      // unrelated peer whose metadata grew. The caller owns close/telemetry.
      trySetConnectionState(connection, () => previousState);
      failures.push(connection);
    }
  }
  return failures;
}

/**
 * Observe accepted native updates, not a second decoder or guessed ownership.
 * The pinned YServer handler and awareness events are synchronous.
 * @param {Connection} sender
 * @param {Connection[]} connections
 * @param {Awareness} awareness
 * @param {() => void} handleMessage
 */
export function handleAwarenessMessage(sender, connections, awareness, handleMessage) {
  const owners = awarenessOwners(connections);
  /** @type {Set<number>} */
  const accepted = new Set();
  /** @param {{ added: number[], updated: number[] }} change @param {unknown} origin */
  const observe = ({ added, updated }, origin) => {
    if (origin !== sender) return;
    for (const id of [...added, ...updated]) {
      if (awareness.getStates().has(id)) accepted.add(id);
    }
  };
  awareness.on("update", observe);
  try { handleMessage(); } finally { awareness.off("update", observe); }
  return rememberAwarenessClocks(connections, owners, awareness, {
    senderId: sender.id, ids: [...accepted],
  });
}

/**
 * Native removal emits nothing for an absent state. Reconstitute only missing
 * owned entries just before synchronous native onClose removes them. The empty
 * placeholder is never sent; the native listener broadcasts a clocked null.
 * Existing in-memory states/clocks remain authoritative when they are newer.
 * @param {Connection} connection
 * @param {Awareness} awareness
 */
export function prepareAwarenessDeparture(connection, awareness) {
  const savedClocks = clocks(connection);
  for (const id of ownedIds(connection)) {
    const clock = savedClocks[id];
    if (clock === undefined) continue;
    const meta = awareness.meta.get(id);
    if (meta && meta.clock >= clock) continue;
    awareness.meta.set(id, { clock, lastUpdated: Date.now() });
    if (!awareness.getStates().has(id)) awareness.getStates().set(id, {});
  }
}
