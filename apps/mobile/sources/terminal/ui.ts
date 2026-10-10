/**
 * Presentation of the terminal context. App routes import screens from here.
 *
 * The live screen (`TerminalRoute`, `TerminalScreen`, `TerminalView`) is
 * deliberately NOT re-exported: importing it drags xterm and the whole
 * terminal stack into the importer's bundle, and this barrel is reached from
 * the landing path (LiveTerminalsRow, HomeDock). The session route imports
 * `TerminalRoute` through `terminal/presentation/TerminalRouteLoader`, which
 * resolves to its web variant on web, so the terminal loads with the route
 * that draws one.
 */
export * from './presentation/AgentInputAttachmentStrip';
export * from './presentation/GitStatusBadge';
export * from './presentation/TerminalPreview';
export * from './presentation/TerminalKeyRow';
export * from './presentation/TerminalColorsSettings';
export { useTerminalColors } from './presentation/useTerminalColors';
