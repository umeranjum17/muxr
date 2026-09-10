/** Presentation of the terminal context. App routes import screens from here. */
export * from './presentation/AgentInputAttachmentStrip';
export * from './presentation/GitStatusBadge';
export * from './presentation/TerminalPreview';
export * from './presentation/TerminalScreen';
// TerminalView stays out of this barrel on purpose: TerminalScreen lazy-loads
// it so the xterm/Ghostty implementation never enters the initial graph.
