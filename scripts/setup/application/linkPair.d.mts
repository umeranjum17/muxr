import type { LinkEndpoint } from '../../../apps/host/src/machine/infrastructure/linkEndpoint.js';

export function startHostPairingServer(endpoint: LinkEndpoint, socketPath: string, relayUrl: string, herdrSession?: string): Promise<{ close(): Promise<void> }>;
