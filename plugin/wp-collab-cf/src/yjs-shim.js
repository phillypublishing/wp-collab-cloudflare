// Webpack aliases yjs here so y-partyserver and y-protocols share the editor's
// module instead of bundling a second Yjs implementation. Their Yjs calls run
// inside functions, so initialize these live bindings before provider creation.
// Recheck that ordering and these exports when upgrading either dependency.
export let Doc;
export let applyUpdate;
export let encodeStateVector;
export let encodeStateAsUpdate;

export function setYjsModule( Y ) {
	( { Doc, applyUpdate, encodeStateVector, encodeStateAsUpdate } = Y );
}
