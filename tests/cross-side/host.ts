/**
 * The host side of every cross-side test. These tests drive the phone's real
 * modules against the host's, so they belong to neither app. Everything they
 * take from the host comes through here (and `hostSetup.ts`): when the host
 * moves to its own repository, only these two files change, to read the host
 * from its pinned published package instead of the workspace.
 */
import { join } from 'node:path';

export { startRelay } from '@muxr/relay';
export { LinkEndpoint } from '../../apps/host/src/machine/infrastructure/linkEndpoint.js';
export type { MachineCryptoState } from '../../apps/host/src/machine/domain/crypto.js';
export { ArtifactWatcher } from '../../apps/host/src/agent/infrastructure/artifactWatcher.js';
export { pairingIntent } from '../../scripts/setup/domain/pairing.js';
export { waitForRelay } from '../../scripts/diagnostics/application/waitForRelay.mjs';

export const hostRoot = join(import.meta.dirname, '../..');
export const relayMain = join(hostRoot, 'apps/relay/dist/main.js');
export const hostMain = join(hostRoot, 'apps/host/dist/main.js');
export const cliMain = join(hostRoot, 'scripts/cli.mjs');
