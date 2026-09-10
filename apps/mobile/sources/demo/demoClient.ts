import type {
    AgentLifecycle,
    RequestParams,
    RequestResult,
    RequestType,
    SessionEvent,
    SessionEventBody,
    SessionStatus,
} from '@muxr/contract';
import type { ConnectionState, MuxrTransport } from '@/pairing/infrastructure/muxrClient';
import {
    DEMO_ARTIFACT_CONTENT,
    DEMO_ARTIFACT_PATCH,
    DEMO_ARTIFACT_PATH,
    DEMO_ATTENTION,
    DEMO_CONTINUATION,
    DEMO_LIFECYCLE,
    DEMO_MACHINES,
    DEMO_PLUGIN_MANIFEST,
    DEMO_PLUGIN_MANIFEST_HASH,
    DEMO_PLUGIN_SUMMARY,
    DEMO_SESSION_BLOCKED,
    DEMO_SESSION_DONE,
    DEMO_SESSION_WORKING,
    DEMO_SESSIONS,
    DEMO_TRANSCRIPTS,
    DEMO_WORKSPACE,
} from './demoRecords';

/**
 * Deterministic in-memory transport behind the MuxrSync seam. Serves the
 * demo records through production request/event paths: the herd tree,
 * catalog, attention, lifecycle, plugin, terminal-preview, and file reads
 * all arrive the way a host would send them, and session.prompt/answer on
 * the blocked agent drives a real blocked → working → done transition with
 * Inbox reconciliation. Anything else fails closed and visibly.
 *
 * Web-only by selection (demoRuntime), never by import: this module touches
 * no DOM, no storage, no network.
 */

type EventListener = (sessionId: string, event: SessionEvent) => void;
type StateListener = (state: ConnectionState) => void;

const DEMO_TOKENS = { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, total: 1540 };

function statusFor(sessionId: string, agentStatus: AgentLifecycle, promptable: boolean, isStreaming: boolean): SessionStatus {
    return {
        sessionId,
        persisted: true,
        agentStatus,
        promptable,
        isStreaming,
        tokens: DEMO_TOKENS,
        cost: 0.021,
        contextUsage: { tokens: 1540, contextWindow: 200_000, percent: 0.77 },
    };
}

type BlockedPhase = 'blocked' | 'working' | 'done';

class DemoClient implements MuxrTransport {
    state: ConnectionState = 'closed';
    private readonly eventListeners = new Set<EventListener>();
    private readonly stateListeners = new Set<StateListener>();
    private timers: ReturnType<typeof setTimeout>[] = [];
    private closed = false;
    private blockedPhase: BlockedPhase = 'blocked';
    private seq = 0;
    /** Mutable transcript buffers; the memory terminal channel reads these. */
    private readonly transcripts: Record<string, string[]> = {
        [DEMO_SESSION_WORKING]: [...DEMO_TRANSCRIPTS[DEMO_SESSION_WORKING]!],
        [DEMO_SESSION_BLOCKED]: [...DEMO_TRANSCRIPTS[DEMO_SESSION_BLOCKED]!],
        [DEMO_SESSION_DONE]: [...DEMO_TRANSCRIPTS[DEMO_SESSION_DONE]!],
    };
    private readonly transcriptListeners = new Set<(sessionId: string, lines: string[]) => void>();

    isLive(): boolean {
        return this.state === 'open';
    }

    connect(): void {
        if (this.closed || this.state === 'open' || this.state === 'connecting') return;
        this.setState('connecting');
        this.after(250, () => {
            this.setState('open');
            this.emitInitial();
        });
    }

    close(): void {
        this.closed = true;
        this.timers.forEach(clearTimeout);
        this.timers = [];
        this.setState('closed');
    }

    onEvent(listener: EventListener): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }

    onStateChange(listener: StateListener): () => void {
        this.stateListeners.add(listener);
        return () => {
            this.stateListeners.delete(listener);
        };
    }

    /** Full replay reset for the DemoBar reset action. */
    reset(): void {
        this.timers.forEach(clearTimeout);
        this.timers = [];
        this.blockedPhase = 'blocked';
        this.transcripts[DEMO_SESSION_WORKING] = [...DEMO_TRANSCRIPTS[DEMO_SESSION_WORKING]!];
        this.transcripts[DEMO_SESSION_BLOCKED] = [...DEMO_TRANSCRIPTS[DEMO_SESSION_BLOCKED]!];
        this.transcripts[DEMO_SESSION_DONE] = [...DEMO_TRANSCRIPTS[DEMO_SESSION_DONE]!];
        if (this.state === 'open') this.emitInitial();
    }

    transcript(sessionId: string): string[] {
        return [...(this.transcripts[sessionId] ?? [])];
    }

    knows(sessionId: string): boolean {
        return this.transcripts[sessionId] !== undefined;
    }

    onTranscript(listener: (sessionId: string, lines: string[]) => void): () => void {
        this.transcriptListeners.add(listener);
        return () => {
            this.transcriptListeners.delete(listener);
        };
    }

    /** Terminal input path. Echoes honestly; approval text continues the blocked agent. */
    writeInput(sessionId: string, text: string): void {
        const clean = text.replace(/\r/g, '\n');
        if (clean.trim() === '') return;
        this.appendTranscript(sessionId, [`$ ${clean.trim()}`]);
        if (sessionId === DEMO_SESSION_BLOCKED && this.blockedPhase === 'blocked') {
            this.continueBlocked(`terminal input: ${clean.trim()}`);
        }
    }

    async request<T extends RequestType>(type: T, params: RequestParams<T>): Promise<RequestResult<T>> {
        return this.handle(type as string, params) as Promise<RequestResult<T>>;
    }

    private async handle(type: string, params: unknown): Promise<unknown> {
        const p = params as Record<string, unknown>;
        switch (type) {
            case 'herdr.tree':
                return { workspaces: [this.tree()], connected: true };
            case 'machines.list':
                return DEMO_MACHINES;
            case 'session.list':
                return this.sessions();
            case 'attention.catalog':
                return { revision: this.blockedPhase === 'done' ? 2 : 1, entries: this.attention() };
            case 'lifecycle.catalog':
                return this.lifecycle();
            case 'plugin.list':
                return [{ ...DEMO_PLUGIN_SUMMARY }];
            case 'plugin.manifest':
                if (p['pluginId'] !== 'muxr.terminal-keys' || p['manifestHash'] !== DEMO_PLUGIN_MANIFEST_HASH) {
                    throw new Error('demo replay: unknown plugin snapshot');
                }
                return DEMO_PLUGIN_MANIFEST;
            case 'session.prompt': {
                const sessionId = String(p['sessionId'] ?? '');
                const text = String(p['text'] ?? '');
                // The composer has no terminal echo of its own: mirror the
                // sent text into the transcript so the session shows it.
                if (text.trim() !== '') this.appendTranscript(sessionId, [`$ ${text.slice(0, 200)}`]);
                this.answerBlocked(sessionId, text);
                return null;
            }
            case 'session.answer': {
                const sessionId = String(p['sessionId'] ?? '');
                if (sessionId === DEMO_SESSION_BLOCKED && this.blockedPhase === 'blocked') {
                    if (p['answer'] === 'y') {
                        this.answerBlocked(sessionId, 'approved');
                    } else {
                        this.appendTranscript(sessionId, ['$ declined — still blocked']);
                        this.emit(sessionId, {
                            type: 'status.update',
                            status: statusFor(sessionId, 'blocked', true, false),
                        });
                    }
                }
                return null;
            }
            case 'session.status': {
                const sessionId = String(p['sessionId'] ?? '');
                return statusFor(sessionId, this.agentStatus(sessionId), sessionId !== DEMO_SESSION_DONE, this.isWorking(sessionId));
            }
            case 'session.readFile': {
                if (String(p['sessionId'] ?? '') === DEMO_SESSION_DONE && String(p['path'] ?? '').endsWith(DEMO_ARTIFACT_PATH)) {
                    return { content: DEMO_ARTIFACT_CONTENT };
                }
                throw new Error('demo replay: file not in the recorded run');
            }
            case 'session.shell': {
                const command = String(p['command'] ?? '');
                if (String(p['sessionId'] ?? '') === DEMO_SESSION_DONE && command.includes('git ') && (command.includes('diff') || command.includes('log '))) {
                    return { output: DEMO_ARTIFACT_PATCH, exitCode: 0, truncated: false, isError: false };
                }
                return null;
            }
            case 'pane.read': {
                const sessionId = String(p['sessionId'] ?? '');
                return { text: (this.transcripts[sessionId] ?? []).join('\n'), truncated: false };
            }
            default:
                // Fail closed and visibly: no network fallback, no invented data.
                throw new Error(`unsupported in demo replay: ${type}`);
        }
    }

    private agentStatus(sessionId: string): AgentLifecycle {
        if (sessionId === DEMO_SESSION_BLOCKED) {
            if (this.blockedPhase === 'working') return 'working';
            if (this.blockedPhase === 'done') return 'done';
            return 'blocked';
        }
        return sessionId === DEMO_SESSION_WORKING ? 'working' : 'done';
    }

    private isWorking(sessionId: string): boolean {
        return this.agentStatus(sessionId) === 'working';
    }

    private sessions() {
        return DEMO_SESSIONS.map((session) => {
            if (session.id !== DEMO_SESSION_BLOCKED) return session;
            const status = this.agentStatus(session.id);
            return { ...session, agentStatus: status };
        });
    }

    private tree() {
        return {
            ...DEMO_WORKSPACE,
            agentStatus: this.blockedPhase === 'done' ? 'working' as const : DEMO_WORKSPACE.agentStatus,
            tabs: DEMO_WORKSPACE.tabs.map((tab) => ({
                ...tab,
                panes: tab.panes.map((pane) => {
                    if (pane.sessionId === undefined || pane.sessionId !== DEMO_SESSION_BLOCKED) return pane;
                    return { ...pane, agentStatus: this.agentStatus(pane.sessionId) };
                }),
            })),
        };
    }

    private attention() {
        if (this.blockedPhase === 'done') return [];
        return DEMO_ATTENTION;
    }

    private lifecycle() {
        if (this.blockedPhase === 'done') {
            return {
                revision: 2,
                events: [
                    ...DEMO_LIFECYCLE.events.filter((event) => event.sessionId !== DEMO_SESSION_BLOCKED),
                    {
                        eventId: 'demo-ev-unblocked',
                        sessionId: DEMO_SESSION_BLOCKED,
                        agentName: 'Bex',
                        state: 'done' as const,
                        reasonCode: 'agent-done' as const,
                        reason: 'agent-done' as const,
                        at: new Date().toISOString(),
                    },
                ],
            };
        }
        return DEMO_LIFECYCLE;
    }

    private emit(sessionId: string, body: SessionEventBody): void {
        const event = { ...body, seq: (this.seq += 1) } as SessionEvent;
        for (const listener of [...this.eventListeners]) listener(sessionId, event);
    }

    private emitInitial(): void {
        for (const session of this.sessions()) {
            this.emit(session.id, { type: 'session.created', session });
            this.emit(session.id, { type: 'session.updated', session });
            this.emit(session.id, {
                type: 'status.update',
                status: statusFor(session.id, session.agentStatus, session.promptable, session.agentStatus === 'working'),
            });
        }
        this.emit(DEMO_SESSION_BLOCKED, {
            type: 'attention.update',
            catalog: { revision: 1, entries: DEMO_ATTENTION },
        });
        for (const event of DEMO_LIFECYCLE.events) {
            this.emit(event.sessionId, { type: 'lifecycle.update', event });
        }
    }

    /** The recorded answer: composer text or terminal approval continues Bex. */
    private answerBlocked(sessionId: string, text: string): void {
        if (sessionId !== DEMO_SESSION_BLOCKED || this.blockedPhase !== 'blocked') return;
        this.continueBlocked(text);
    }

    private continueBlocked(text: string): void {
        this.blockedPhase = 'working';
        this.appendTranscript(DEMO_SESSION_BLOCKED, [`$ approve: ${text.slice(0, 120)}`]);
        this.emit(DEMO_SESSION_BLOCKED, {
            type: 'status.update',
            status: statusFor(DEMO_SESSION_BLOCKED, 'working', true, true),
        });
        this.emit(DEMO_SESSION_BLOCKED, {
            type: 'activity.update',
            activity: { sessionId: DEMO_SESSION_BLOCKED, phase: 'active', label: 'pushing', at: new Date().toISOString() },
        });
        this.after(900, () => this.appendTranscript(DEMO_SESSION_BLOCKED, DEMO_CONTINUATION.slice(0, 2)));
        this.after(1800, () => {
            this.appendTranscript(DEMO_SESSION_BLOCKED, DEMO_CONTINUATION.slice(2));
            this.blockedPhase = 'done';
            this.emit(DEMO_SESSION_BLOCKED, {
                type: 'status.update',
                status: statusFor(DEMO_SESSION_BLOCKED, 'done', true, false),
            });
            this.emit(DEMO_SESSION_BLOCKED, {
                type: 'activity.update',
                activity: { sessionId: DEMO_SESSION_BLOCKED, phase: 'idle', label: 'idle', at: new Date().toISOString() },
            });
            // Inbox reconciles: the blocked entry leaves the catalog.
            this.emit(DEMO_SESSION_BLOCKED, { type: 'attention.update', catalog: { revision: 2, entries: [] } });
            this.emit(DEMO_SESSION_BLOCKED, {
                type: 'lifecycle.update',
                event: {
                    eventId: 'demo-ev-unblocked',
                    sessionId: DEMO_SESSION_BLOCKED,
                    agentName: 'Bex',
                    state: 'done',
                    reasonCode: 'agent-done',
                    reason: 'agent-done',
                    at: new Date().toISOString(),
                },
            });
        });
    }

    private appendTranscript(sessionId: string, lines: string[]): void {
        const buffer = this.transcripts[sessionId];
        if (buffer === undefined) return;
        buffer.push(...lines);
        for (const listener of [...this.transcriptListeners]) listener(sessionId, [...buffer]);
    }

    private setState(state: ConnectionState): void {
        this.state = state;
        for (const listener of [...this.stateListeners]) listener(state);
    }

    private after(ms: number, work: () => void): void {
        if (this.closed) return;
        this.timers.push(setTimeout(() => {
            if (!this.closed) work();
        }, ms));
    }
}

export const demoClient = new DemoClient();
