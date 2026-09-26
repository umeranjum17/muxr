import { join } from 'node:path';
import { Relay, type RelayState } from '@byokit/relay';
import { readPrivateFile, writeJsonFileAtomic } from '../../platform/persist.js';

/**
 * The link relay beside muxr's own routes: devices dial /link/v1/<host id>,
 * the host keeps one socket at /relay/v1/host and proves its machine key.
 * The owner is whoever holds the mint secret, the same boundary as ticket
 * minting, so only this machine's host can enrol itself.
 *
 * Its state is the list of admitted hosts and is never restored from a backup:
 * an old copy could bring back a revoked host.
 */
export async function openLinkRelay(dataDir: string, ownerToken: string,
    push?: { subject?: string; fetch?: typeof fetch }): Promise<Relay> {
    const path = join(dataDir, 'link-relay.json');
    return Relay.open({
        ownerToken,
        ...(push === undefined ? {} : { push }),
        store: {
            load: async () => {
                const raw = await readPrivateFile(path);
                return raw === undefined ? undefined : JSON.parse(raw) as RelayState;
            },
            save: (state) => writeJsonFileAtomic(path, state),
        },
    });
}
