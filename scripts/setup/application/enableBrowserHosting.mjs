import { parseConnection } from '../domain/dist/index.js';
import { error, print } from '../infrastructure/runtime.mjs';
import { readSelfhostState } from '../infrastructure/selfhost.mjs';
import { startSelfHost } from './startSelfHost.mjs';

/** Enable the bundled web client without reopening unrelated setup choices. */
export async function enableBrowserHosting() {
    const state = readSelfhostState();
    if (state === undefined) return 1;
    const connection = parseConnection(state);
    if (!connection.ok) return 1;
    if (connection.value.browserHostingReady()) return 0;
    const rejection = connection.value.rejectionForBrowserHosting();
    if (rejection !== undefined) {
        error(rejection);
        return 1;
    }
    print('Enabling browser access on the current secure connection…');
    return startSelfHost([
        '--reconfigure', '--web', '--yes', '--no-pair',
        '--port', String(state.relayPort),
        ...connection.value.reconfigureArgs(),
    ]);
}
