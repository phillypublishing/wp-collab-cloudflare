export const RESOURCE_LIMIT_CLOSE_CODE = 4008;

/**
 * Resource-limit closes are terminal until an operator reviews the room.
 * Authentication-expiry closes intentionally remain reconnectable so the
 * provider can mint a fresh short-lived credential.
 *
 * @param {{ code?: number }}          event               WebSocket close event.
 * @param {{ disconnect: () => void }} provider            Collaboration provider.
 * @param {() => void}                 notifyTerminalClose Persistent editor notice callback.
 * @return {boolean} Whether the close was terminal.
 */
export function handleConnectionClose( event, provider, notifyTerminalClose ) {
	if ( event.code !== RESOURCE_LIMIT_CLOSE_CODE ) {
		return false;
	}

	provider.disconnect();
	notifyTerminalClose();
	return true;
}
