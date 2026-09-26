/** Public library surface of the muxr core relay. */
export { startRelay, type RelayHandle, type RelayOptions } from './relay.js';
export {
    loadRelayConfig,
    clientIp,
    isLoopbackAddress,
    type RelayConfig,
} from './config.js';
export { readJsonBody, writeJson } from './httpJson.js';
