// @ts-check

/**
 * Retired Worker-side Yjs snapshot key. New document updates are never written
 * to Durable Object storage; this key remains only to scrub rooms created by
 * versions that did persist the document.
 */
export const LEGACY_YJS_STATE_KEY = "yjs-state-v1";

/**
 * @param {{ delete: (key: string) => Promise<boolean> }} storage
 */
export async function clearLegacyDocumentState(storage) {
  await storage.delete(LEGACY_YJS_STATE_KEY);
}
