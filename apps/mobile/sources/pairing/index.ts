/** Public API of the pairing context. Screens live in `./ui`. */
export * from './application/PairMachine';
export * from './application/ReconnectMachine';
export { forgetMachine } from './application/forgetMachine';
export { restoreConnection } from './application/restoreConnection';
export * from './application/useCheckCameraPermissions';
export * from './application/useDeviceAuthority';
export * from './application/usePairing';
export * from './application/useRelayDiscovery';
export * from './domain/ConnectionStatus';
export * from './domain/PairedMachine';
export * from './domain/machineUtils';
export * from './infrastructure/muxrClient';

export {
    acceptVerifiedGrant,
    accountSurfaceApplies,
    connectionShouldAdoptGrant,
    defaultDeviceAuthority,
    grantAuthorizesMachine,
    grantRejectsDowngrade,
    hostedTransportReady,
    pickGrantForConnection,
    type DeviceAuthority,
    type VerifiedGrantDecision,
} from './domain/hostedGrant';
export {
    hostedPairingAuthority,
    hostedPairingDisplayName,
    parsePairingString,
    prepareHostedPairingInput,
    type PairingString,
    type PairingStringParse,
} from './domain/pairingString';
