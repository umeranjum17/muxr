import { MISSING_CWD_ERROR_PREFIX, type SessionStatus } from '@muxr/contract';
import { applyStatusToSession } from '../infrastructure/sessionMapping';
import type { SessionAgentModesPatch } from '../infrastructure/storageTypes';
import { startAgent } from './startAgent';
import { readAgentFile } from './readAgentFile';
import { stopAgent } from './stopAgent';
import type { NewSessionAgentType } from './persistence';
import { storage } from './storage';
import { sync } from './sync';

export type { SessionAgentModesPatch };

/** Catalog host adapter. Named use cases live beside this file. */

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: NewSessionAgentType;
    displayName?: string;
    permissionMode?: string;
    modelMode?: string;
    effortLevel?: string;
    resumeClaudeSessionId?: string;
    resumeCodexThreadId?: string;
    parentSessionId?: string;
    forkedFromMessageId?: string;
    isSideChat?: boolean;
}

export interface ClaudeForkSessionOptions {
    machineId: string;
    directory: string;
    claudeSessionId: string;
}

export type ClaudeForkSessionResult =
    | { type: 'success'; newClaudeSessionId: string }
    | { type: 'error'; errorMessage: string };

export interface ClaudeRewindPoint {
    uuid: string;
    text: string;
    timestamp: number;
}

export type ClaudeListRewindPointsResult =
    | { type: 'success'; points: ClaudeRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface CodexForkThreadOptions {
    machineId: string;
    directory: string;
    codexThreadId: string;
}

export type CodexForkThreadResult =
    | { type: 'success'; newCodexThreadId: string }
    | { type: 'error'; errorMessage: string };

export interface CodexRewindPoint {
    itemId: string;
    text: string;
    timestamp: number;
}

export type CodexListRewindPointsResult =
    | { type: 'success'; points: CodexRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
}

export type ForkSource = ClaudeForkSource | CodexForkSource;

export interface ClaudeForkSource {
    kind: 'claude';
    machineId: string;
    directory: string;
    claudeSessionId: string;
}

export interface CodexForkSource {
    kind: 'codex';
    machineId: string;
    directory: string;
    codexThreadId: string;
}

export interface ForkOptions {
    cutAfterUuid?: string;
    cutAfterItemId?: string;
    forkedFromMessageId?: string;
    isSideChat?: boolean;
}

interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string;
    error?: string;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

interface SessionKillResponse {
    success: boolean;
    message: string;
}

export async function sessionAbort(sessionId: string): Promise<void> {
    await stopAgent({ agentRoute: sessionId, kind: 'abort' }, {
        abort: (agentRoute) => sync.request('session.abort', { sessionId: agentRoute }),
        stop: (agentRoute) => sync.request('session.stop', { sessionId: agentRoute }),
        refreshCatalog: () => sync.refreshSessions(),
    });
}

export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    await stopAgent({ agentRoute: sessionId, kind: 'stop' }, {
        abort: (agentRoute) => sync.request('session.abort', { sessionId: agentRoute }),
        stop: (agentRoute) => sync.request('session.stop', { sessionId: agentRoute }),
        refreshCatalog: () => sync.refreshSessions(),
    });
    return { success: true, message: 'stopped' };
}

export function sessionSetAgentModes(_sessionId: string, _patch: SessionAgentModesPatch): void {
    // The herdr host owns model/thinking selection per pane; there is no
    // setModel/setThinkingLevel request. Permission modes are decided in the
    // agent's own TUI. Kept as a no-op so session quick actions can call it.
}

export async function sessionAllow(
    _sessionId: string,
    _id: string,
    _mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    _allowedTools?: string[],
    _decision?: 'approved' | 'approved_for_session',
    _updatedInput?: Record<string, unknown>,
): Promise<void> {}

export async function sessionDeny(
    _sessionId: string,
    _id: string,
    _mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    _allowedTools?: string[],
    _decision?: 'denied' | 'abort',
): Promise<void> {}

export async function sessionSwitch(_sessionId: string, _to: 'remote' | 'local'): Promise<boolean> {
    return false;
}

export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    const outcome = await sync.runShell(sessionId, request.command, request.timeout, true);
    return {
        success: !outcome.isError && outcome.exitCode === 0,
        stdout: outcome.stdout,
        stderr: '',
        exitCode: outcome.exitCode,
        ...(outcome.timedOut === true ? { error: 'Shell timed out' } : {}),
    };
}

/** No contract request for file search yet; fails closed rather than calling out. */
export async function sessionRipgrep(
    _sessionId: string,
    _args: string[],
    _cwd?: string,
): Promise<{ success: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }> {
    return { success: false, error: 'muxr mobile: file search not wired' };
}

export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    const result = await readAgentFile({ agentRoute: sessionId, path }, {
        read: (agentRoute, filePath) => sync.request('session.readFile', { sessionId: agentRoute, path: filePath }),
    });
    if (!result.ok) return { success: false, error: result.message };
    return { success: true, content: result.content };
}

export async function sessionWriteFile(
    _sessionId: string,
    _path: string,
    _content: string,
    _expectedHash?: string | null,
): Promise<SessionWriteFileResponse> {
    return { success: false, error: 'muxr mobile: session write file not wired' };
}

export async function machineBash(
    _machineId: string,
    command: string,
    cwd: string,
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
    // machineId is ignored: requests already route to the connected machine.
    const result = await sync.request('machine.shell', { command, cwd });
    return { ...result, success: result.exitCode === 0 };
}

export async function refreshUntilSessionVisible(sessionId: string): Promise<void> {
    // session.start can return before the host lists the session. Polling keeps
    // every launch surface from opening a terminal that immediately looks deleted.
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await sync.refreshSessions();
        if (storage.getState().sessions[sessionId] !== undefined) return;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
}

export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const result = await startAgent({
        directory: options.directory,
        createDirectory: options.approvedNewDirectoryCreation,
        parentAgentRoute: options.parentSessionId,
        kind: options.agent,
        humanName: options.displayName,
    }, {
        startOnHost: async (input) => sync.request('session.start', {
            cwd: input.directory,
            ...(input.createDirectory === true ? { createCwd: true } : {}),
            ...(input.parentAgentRoute === undefined ? {} : { parentSessionId: input.parentAgentRoute }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.humanName === undefined ? {} : { displayName: input.humanName }),
        }),
        waitUntilListed: refreshUntilSessionVisible,
        missingDirectory: (message) => message.includes(MISSING_CWD_ERROR_PREFIX),
    });
    if (result.ok) return { type: 'success', sessionId: result.agentRoute };
    if (result.reason === 'missing-directory') {
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };
    }
    return { type: 'error', errorMessage: result.message };
}

export async function machineResumeSession(
    _options: ResumeSessionOptions & { model?: string; permissionMode?: string },
): Promise<SpawnSessionResult> {
    return { type: 'error', errorMessage: 'Resume via session list' };
}

export async function claudeListRewindPoints(_options: ClaudeForkSessionOptions): Promise<ClaudeListRewindPointsResult> {
    return { type: 'error', errorMessage: 'muxr mobile: claude rewind not wired' };
}

export async function codexListRewindPoints(_options: CodexForkThreadOptions): Promise<CodexListRewindPointsResult> {
    return { type: 'error', errorMessage: 'muxr mobile: codex rewind not wired' };
}

export async function forkAndSpawn(_source: ForkSource, _opts: ForkOptions = {}): Promise<SpawnSessionResult> {
    return { type: 'error', errorMessage: 'Fork not available in muxr mobile shim' };
}

export async function spawnSideChat(_source: ForkSource): Promise<SpawnSessionResult> {
    return { type: 'error', errorMessage: 'Side chat not available in muxr mobile shim' };
}
