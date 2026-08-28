/** Public library surface of the muxr core relay. */
export { startRelay, type RelayHandle, type RelayOptions } from './relay.js';
export {
    loadRelayConfig,
    clientIp,
    isLoopbackAddress,
    type RelayAuthMode,
    type RelayConfig,
    type RelayE2eeMode,
} from './config.js';
export type { Ticket } from './admission/index.js';
export { FileTicketStore } from './admission/index.js';
export { readJsonBody, writeJson } from './httpHandlers.js';
