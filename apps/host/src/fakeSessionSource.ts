/**
 * A session source that emits every event variant in the contract.
 *
 * Purpose: prove the full event vocabulary survives host -> relay -> client
 * with zero translation, without needing a live herdr server.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    SESSION_EVENT_TYPES,
    type SessionEventBody,
    type SessionInfo,
    type SessionSnapshot,
    type SessionStatus,
} from '@muxr/contract';
import type {
    SessionListOptions,
    SessionOpenOptions,
    SessionPromptOptions,
    SessionSaveAttachmentsOptions,
    SessionShellOptions,
    SessionShellOutcome,
    SessionReadFileOptions,
    SessionSource,
    SessionStartOptions,
} from './sessionSource.js';

function statusFor(sessionId: string, isStreaming: boolean): SessionStatus {
    return {
        sessionId,
        persisted: true,
        agentStatus: isStreaming ? 'working' : 'idle',
        isStreaming,
        tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, total: 1540 },
        cost: 0.021,
        contextUsage: { tokens: 1540, contextWindow: 200_000, percent: 0.77 },
    };
}

function snapshotFor(session: SessionInfo): SessionSnapshot {
    return {
        info: session,
        status: statusFor(session.id, false),
        page: { messages: [], hasMore: false },
    };
}

/** One realistic turn that exercises every variant exactly once. */
function scriptedTurn(sessionId: string, session: SessionInfo, demoWrite: { path: string; content: string }): SessionEventBody[] {
    void demoWrite;
    return [
        { type: 'session.created', session },
        { type: 'session.updated', session },
        { type: 'status.update', status: statusFor(sessionId, true) },
        { type: 'activity.update', activity: { sessionId, phase: 'active', label: 'working', at: new Date().toISOString() } },
        { type: 'shell.start', command: 'yarn typecheck' },
        { type: 'shell.chunk', chunk: 'tsc --noEmit\n' },
        { type: 'shell.end', output: 'ok', exitCode: 0, truncated: false, isError: false },
        {
            type: 'attention.update',
            catalog: {
                revision: 1,
                entries: [{ sessionId: 'fake-1', reason: 'done', detail: 'Agent finished', at: '2026-01-01T00:00:00.000Z' }],
            },
        },
        { type: 'status.update', status: statusFor(sessionId, false) },
        { type: 'activity.update', activity: { sessionId, phase: 'idle', label: 'idle', at: new Date().toISOString() } },
        { type: 'watch.settled', status: 'done', detail: 'agent is done' },
        { type: 'session.removed' },
        { type: 'session.error', message: 'demonstrating the error variant' },
    ];
}

export function createFakeSessionSource(): SessionSource {
    const listeners = new Set<(sessionId: string, event: SessionEventBody) => void>();
    const sessions = new Map<string, SessionInfo>();
    let counter = 0;

    function emit(sessionId: string, event: SessionEventBody): void {
        for (const listener of listeners) listener(sessionId, event);
    }

    function requireSession(sessionId: string): SessionInfo {
        const session = sessions.get(sessionId);
        if (session === undefined) throw new Error(`unknown session: ${sessionId}`);
        return session;
    }

    return {
        async refreshHerdr() {},

        async herdrTree() {
            return { workspaces: [], connected: true };
        },

        async agentKinds() {
            return ['pi', 'claude', 'codex'];
        },

        async pluginList() {
            return [];
        },

        async pluginManifest() {
            throw new Error('fake source has no plugins');
        },

        async pluginApprove() {
            throw new Error('fake source has no plugins');
        },

        async pluginInvoke() {
            throw new Error('fake source has no plugins');
        },

        async pluginCall() {
            throw new Error('fake source has no plugins');
        },

        async pluginStream() {
            throw new Error('fake source has no plugins');
        },

        async voiceProviderList() {
            return [
                { id: 'xai', name: 'Grok', available: true, selected: true },
                { id: 'gemini', name: 'Gemini Live', available: true, selected: false },
                { id: 'openai', name: 'OpenAI Realtime', available: true, selected: false },
            ];
        },

        async voiceProviderSelect(provider) {
            return (await this.voiceProviderList()).map((candidate) => ({ ...candidate, selected: candidate.id === provider }));
        },

        async herdrLayout() {
            throw new Error('fake source has no panes');
        },

        async paneSplit() {
            throw new Error('fake source has no panes');
        },

        async paneRead() {
            throw new Error('fake source has no panes');
        },

        async agentWatch() {
            throw new Error('fake source has no panes');
        },

        async layoutExport() {
            throw new Error('fake source has no panes');
        },

        async layoutApply() {
            throw new Error('fake source has no panes');
        },

        async paneFocus() {
            throw new Error('fake source has no panes');
        },

        async focusNeighbor() {
            throw new Error('fake source has no panes');
        },

        async focusTabNeighbor() {
            throw new Error('fake source has no panes');
        },

        async focusWorkspaceNeighbor() {
            throw new Error('fake source has no panes');
        },

        async createTab() {
            throw new Error('fake source has no panes');
        },

        async closeTab() {
            throw new Error('fake source has no panes');
        },

        async closePane() {
            throw new Error('fake source has no panes');
        },

        async closeWorkspace() {
            throw new Error('fake source has no workspaces');
        },

        async sendKeys() {
            throw new Error('fake source has no panes');
        },

        async paneZoom() {
            throw new Error('fake source has no panes');
        },

        async list(options: SessionListOptions = {}) {
            const all = [...sessions.values()];
            if (options.cwd === undefined) return all;
            return all.filter((session) => session.cwd === options.cwd);
        },

        async start(options: SessionStartOptions): Promise<SessionSnapshot> {
            counter += 1;
            const id = `fake_${String(counter)}`;
            const now = new Date().toISOString();
            const session: SessionInfo = {
                id,
                cwd: options.cwd,
                path: `${options.cwd}/.pi/sessions/${id}.jsonl`,
                created: now,
                modified: now,
                messageCount: 0,
                firstMessage: '',
            };
            sessions.set(id, session);
            emit(id, { type: 'session.created', session });
            return snapshotFor(session);
        },

        async open(options: SessionOpenOptions): Promise<SessionSnapshot> {
            return snapshotFor(requireSession(options.sessionId));
        },

        async prompt(options: SessionPromptOptions) {
            const session = requireSession(options.sessionId);
            // A real file write so the changes pill and the file viewer's diff
            // fallback have something true to show.
            const demoWrite = {
                path: join(session.cwd, 'demo-change.ts'),
                content: [
                    '// written by the fake agent',
                    'export function demo(): string {',
                    "    return 'hello from demo-change';",
                    '}',
                    '',
                ].join('\n'),
            };
            await writeFile(demoWrite.path, demoWrite.content);
            for (const event of scriptedTurn(options.sessionId, session, demoWrite)) emit(options.sessionId, event);
        },


        async status(sessionId) {
            requireSession(sessionId);
            return statusFor(sessionId, false);
        },



        async shell(options: SessionShellOptions) {
            // Runs for real in the session's cwd: the app's git-status and diff
            // surfaces read actual output, and a fixture that always answered
            // 'ok' made them invisible to browser checks.
            const cwd = requireSession(options.sessionId).cwd;
            if (options.quiet) {
                return new Promise<SessionShellOutcome>((resolve) => {
                    execFile('sh', ['-c', options.command], { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
                        const output = (stdout + (stderr ?? '')).trimEnd();
                        const exitCode = error !== null && typeof error.code === 'number' ? error.code : 0;
                        resolve({ output, exitCode, isError: exitCode !== 0 });
                    });
                });
            }
            emit(options.sessionId, { type: 'shell.start', command: options.command });
            execFile('sh', ['-c', options.command], { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
                const output = (stdout + (stderr ?? '')).trimEnd();
                const exitCode = error !== null && typeof error.code === 'number' ? error.code : 0;
                if (output !== '') emit(options.sessionId, { type: 'shell.chunk', chunk: output + '\n' });
                emit(options.sessionId, { type: 'shell.end', output, exitCode, truncated: false, isError: exitCode !== 0 });
            });
            return null;
        },

        async readFile(options: SessionReadFileOptions) {
            // Real read: the file viewer is part of what fake mode demos.
            // Contract is utf8 text (same as the herdr source), not base64.
            const content = await readFile(options.path, 'utf8');
            return { content };
        },










        async saveAttachments(_options: SessionSaveAttachmentsOptions) {
            return { savedPaths: [] };
        },

        async attachmentFetch() {
            return null;
        },

        async attachmentPrepare() {
            return null;
        },

        async attachmentRead() {
            return null;
        },




        async abort() {},
        async stop(sessionId) {
            sessions.delete(sessionId);
        },
        async reload() {},
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async dispose() {
            listeners.clear();
            sessions.clear();
        },
    };
}

/** Guard: the scripted turn must cover the whole vocabulary. */
export function assertFakeSourceCoversContract(): void {
    const emitted = new Set(
        scriptedTurn('s', {
            id: 's',
            cwd: '/tmp',
            path: '/tmp/s.jsonl',
            created: '',
            modified: '',
            messageCount: 0,
            firstMessage: '',
        }, { path: '/tmp/demo-change.ts', content: '' }).map((event) => event.type),
    );
    const missing = SESSION_EVENT_TYPES.filter((type) => !emitted.has(type));
    if (missing.length > 0) {
        throw new Error(`fake source does not cover contract event types: ${missing.join(', ')}`);
    }
}
