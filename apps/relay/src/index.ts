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
export type { Ticket } from './auth.js';
export { FileTicketStore } from './selfhostTickets.js';
export { readJsonBody, writeJson } from './httpHandlers.js';
