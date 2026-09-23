/**
 * Public API of the desktop host engine package.
 *
 * The engine itself is a native per-user process; this package is how a
 * consumer starts it and speaks its local control protocol. Nothing in this
 * surface refers to any particular application.
 */
export * from './protocol.js';
export { EngineClient, type EngineClientOptions } from './engineProcess.js';
export { resolveEngine, explainMissingEngine, enginePackageRoot, type ResolvedEngine } from './resolveEngine.js';
export { Bridge, BRIDGE_PATH, type BridgeOptions } from './bridge.js';
