export {
    accepted,
    advertisedUrlForMode,
    BROWSER_GRANT_TTL_MS,
    connectionLabel,
    DURABLE_GRANT_EXPIRES_AT,
    defaultAuthorityFor,
    ingressPlan,
    modeAllowsBrowserHosting,
    pairingIntent,
    pairingIntentFromDevice,
    pairingIntentFromHostedFlags,
    pairingIntentFromSelfhostFlags,
    parseClientKind,
    parseConnection,
    parseDaemonMode,
    parseDaemonModeArg,
    parseDevice,
    parseDeviceAuthority,
    parseEnrollment,
    parseHostedAuth,
    parseMachineCrypto,
    parsePendingRemote,
    publicRelayUrl,
    rejected,
    validMachineCrypto,
} from './domain/dist/index.js';

export { pairDevice } from './application/pairDevice.mjs';
export { listDevices } from './application/listDevices.mjs';
export { revokeDevice } from './application/revokeDevice.mjs';
export { enrollMachine } from './application/enrollMachine.mjs';
export { listMachines } from './application/listMachines.mjs';
export { revokeMachine } from './application/revokeMachine.mjs';
export { connectEnrollment } from './application/connectEnrollment.mjs';
export { startSelfHost } from './application/startSelfHost.mjs';
export { enableBrowserHosting } from './application/enableBrowserHosting.mjs';
export {
    applyHostedSetup,
    hostedLogin,
    inspectSetup,
    uninstallMuxr,
} from './application/inspectSetup.mjs';
export {
    inspectPeerAgent,
    listPeerMachines,
    promptPeerAgent,
    readPeerSession,
    runPeers,
    watchPeerAgent,
} from './application/promptPeerAgent.mjs';

export {
    applyMachineSetup,
    classifyNetworkRoutes,
    connectRemoteRelay,
    continueWithDirectTailscale,
    hostSharedRelay,
    manageMachines,
    recommendedConnection,
    selfhostArgsFromSetupPlan,
} from './presentation/setupWizard.mjs';

export {
    advertisedRelayHealthy,
    cleanupManagedIngress,
    cloudflaredAlive,
    inspectTailscaleServeRoot,
    persistOwnedServeIngress,
    readSelfhostState,
    runTailscale,
    selfhostConfigured,
    selfhostControlBase,
    selfhostCredential,
    selfhostPath,
    selfhostRelayHealthy,
    selfhostStateUnreadable,
    SERVE_OWNED_ERROR,
    stopOwnedSelfhostRelay,
    tailscaleBin,
    tailscaleIngress,
    writeSelfhostState,
} from './infrastructure/selfhost.mjs';

export {
    browserHostingCanEnable,
    browserHostingReady,
    enrollmentPayload,
    ensureSelfhostRelay,
    hasPendingRemoteConnect,
    resolveAdvertise,
    restartSelfhostRelayIfRunning,
    selfhostPublicSummary,
    sharedMachineCount,
    stopSelfhostRelayIfRunning,
} from './infrastructure/selfhostRelay.mjs';

export {
    daemonDefinition,
    daemonIsRunning,
    daemonMode,
    runDaemon,
    serviceCommand,
    startMuxrDaemon,
} from './infrastructure/daemon.mjs';
export {
    ensureBundledPlugins,
    ensureHerdr,
    ensureHerdrServer,
    herdrBin,
    herdrServerIsReady,
    runBootstrap,
    runIntegrations,
    runLocalPrerequisites,
} from './infrastructure/herdr.mjs';
export { BACK, heading, prompt, select, status } from './presentation/ui.mjs';
export { hostEntry, relayEntry } from './infrastructure/paths.mjs';

export { stateDir } from './infrastructure/runtime.mjs';
