/**
 * Cross-feature telemetry sink for the host connection. A root barrel (not a
 * layer folder) so application coordinators in other features can record
 * connection diagnostics without reaching past catalog's front door — and
 * without evaluating the store, socket, or any native module.
 */
export * from './infrastructure/connectionDiagnostics';
