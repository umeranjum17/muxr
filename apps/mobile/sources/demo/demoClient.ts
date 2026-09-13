import type {
    AgentLifecycle,
    RequestParams,
    RequestResult,
    RequestType,
    SessionEvent,
    SessionEventBody,
    SessionInfo,
    SessionStatus,
} from '@muxr/contract';
import type { ConnectionState, MuxrTransport } from '@/pairing/infrastructure/muxrClient';
import { stripTerminalEscapes } from '@/terminal/application/recentOutput';
import {
    DEMO_ARTIFACT_CONTENT,
    DEMO_ARTIFACT_PATCH,
    DEMO_ARTIFACT_PATH,
    DEMO_ATTENTION,
    DEMO_CHANGES_RESPONSE,
    DEMO_CODE_MANIFEST,
    DEMO_CODE_MANIFEST_HASH,
    DEMO_CODE_SUMMARY,
    DEMO_CONTINUATION,
    DEMO_LIFECYCLE,
    DEMO_MACHINES,
    DEMO_PLUGIN_MANIFEST,
    DEMO_PLUGIN_MANIFEST_HASH,
    DEMO_PLUGIN_SUMMARY,
    DEMO_FILES_REPOS,
    DEMO_FILES_TREE,
    DEMO_INBOX_MANIFEST,
    DEMO_INBOX_MANIFEST_HASH,
    DEMO_INBOX_SUMMARY,
    DEMO_PORTS_EMPTY,
    DEMO_PORTS_MANIFEST,
    DEMO_PORTS_MANIFEST_HASH,
    DEMO_PORTS_SUMMARY,
    DEMO_SESSION_BLOCKED,
    DEMO_SESSION_DONE,
    DEMO_SESSION_WORKING,
    DEMO_SESSIONS,
    DEMO_STATUS_MANIFEST,
    DEMO_STATUS_MANIFEST_HASH,
    DEMO_STATUS_SUMMARY,
    DEMO_TRANSCRIPTS,
    DEMO_USAGE_SNAPSHOT,
    DEMO_VITALS_TEXT,
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
    // Generation, not a latch: close() retires in-flight work, but a later
    // connect() always revives the singleton. A permanent closed flag here
    // bricked the replay after any transport close, with no way back.
    private generation = 0;
    private blockedPhase: BlockedPhase = 'blocked';
    private seq = 0;
    /** Sessions created through the real session.start path; reset clears them. */
    private created: SessionInfo[] = [];
    /** Mutable transcript buffers; the memory terminal channel reads these. */
    private readonly transcripts: Record<string, string[]> = {
        [DEMO_SESSION_WORKING]: [...DEMO_TRANSCRIPTS[DEMO_SESSION_WORKING]!],
        [DEMO_SESSION_BLOCKED]: [...DEMO_TRANSCRIPTS[DEMO_SESSION_BLOCKED]!],
        [DEMO_SESSION_DONE]: [...DEMO_TRANSCRIPTS[DEMO_SESSION_DONE]!],
    };
    private readonly transcriptListeners = new Set<(sessionId: string, lines: string[]) => void>();
    /**
     * Fired when a scripted transition completes (blocked → done). The demo
     * shell uses it to re-read tree-pane state through the production
     * refresh: live cards render tree panes, and nothing else re-reads them
     * after an event-driven transition in a focusless context.
     */
    private readonly transitionListeners = new Set<() => void>();

    isLive(): boolean {
        return this.state === 'open';
    }

    connect(): void {
        if (this.state === 'open' || this.state === 'connecting') return;
        this.setState('connecting');
        this.after(250, () => {
            this.setState('open');
            this.emitInitial();
        });
    }

    close(): void {
        this.generation += 1;
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

    /** Full replay reset for the DemoBar reset action. Revives first if needed. */
    reset(): void {
        this.generation += 1;
        this.timers.forEach(clearTimeout);
        this.timers = [];
        this.blockedPhase = 'blocked';
        for (const created of this.created) delete this.transcripts[created.id];
        this.created = [];
        this.transcripts[DEMO_SESSION_WORKING] = [...DEMO_TRANSCRIPTS[DEMO_SESSION_WORKING]!];
        this.transcripts[DEMO_SESSION_BLOCKED] = [...DEMO_TRANSCRIPTS[DEMO_SESSION_BLOCKED]!];
        this.transcripts[DEMO_SESSION_DONE] = [...DEMO_TRANSCRIPTS[DEMO_SESSION_DONE]!];
        // A reset with a never-opened transport must still bring the herd up:
        // connect() replays the initial catalog on open.
        if (this.state === 'open') this.emitInitial();
        else this.connect();
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

    onTransitionComplete(listener: () => void): () => void {
        this.transitionListeners.add(listener);
        return () => {
            this.transitionListeners.delete(listener);
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
            case 'herdr.agentKinds': {
                // Clean-host replay: the host reports a bounded catalog with
                // only the replay's agents installed. The rest stay
                // unavailable so the reveal/install-guidance surface is
                // exercised, never bypassed.
                return {
                    kinds: ['pi', 'shell', 'claude', 'codex', 'gemini', 'cursor'],
                    installed: ['pi', 'shell', 'claude', 'codex'],
                };
            }
            case 'machine.shell': {
                const command = String(p['command'] ?? '');
                // The replayed project directory is not a git repository, so
                // worktree creation genuinely fails here exactly as it would
                // on a host without a repo. Anything else stays unscripted.
                if (command.includes('git rev-parse')) {
                    return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
                }
                throw new Error(`unsupported in demo replay: ${type} ${command.slice(0, 60)}`);
            }
            case 'plugin.list':
                return [{ ...DEMO_PLUGIN_SUMMARY }, { ...DEMO_STATUS_SUMMARY }, { ...DEMO_INBOX_SUMMARY }, { ...DEMO_CODE_SUMMARY }, { ...DEMO_PORTS_SUMMARY }];
            case 'plugin.manifest': {
                if (p['pluginId'] === 'muxr.terminal-keys' && p['manifestHash'] === DEMO_PLUGIN_MANIFEST_HASH) {
                    return DEMO_PLUGIN_MANIFEST;
                }
                if (p['pluginId'] === 'muxr.code' && p['manifestHash'] === DEMO_CODE_MANIFEST_HASH) {
                    return DEMO_CODE_MANIFEST;
                }
                if (p['pluginId'] === 'muxr.inbox' && p['manifestHash'] === DEMO_INBOX_MANIFEST_HASH) {
                    return DEMO_INBOX_MANIFEST;
                }
                if (p['pluginId'] === 'muxr.status' && p['manifestHash'] === DEMO_STATUS_MANIFEST_HASH) {
                    return DEMO_STATUS_MANIFEST;
                }
                if (p['pluginId'] === 'muxr.servers' && p['manifestHash'] === DEMO_PORTS_MANIFEST_HASH) {
                    return DEMO_PORTS_MANIFEST;
                }
                throw new Error('demo replay: unknown plugin snapshot');
            }
            case 'plugin.call':
            case 'plugin.invoke': {
                // The read RPCs the recorded run exercises. Everything else
                // fails closed, like production with an unavailable capability.
                if (p['pluginId'] === 'muxr.code' && p['contributionId'] === 'changes.list') {
                    const input = p['input'];
                    const sessionId = typeof input === 'object' && input !== null
                        ? String((input as Record<string, unknown>)['sessionId'] ?? '')
                        : '';
                    if (sessionId === DEMO_SESSION_DONE) return DEMO_CHANGES_RESPONSE;
                    return { items: [], total: 0 };
                }
                if (p['pluginId'] === 'muxr.inbox' && p['contributionId'] === 'count') {
                    return { count: this.inboxRows().filter((entry) => entry.bucket === 'needsYou').length };
                }
                if (p['pluginId'] === 'muxr.inbox' && p['contributionId'] === 'list') {
                    return this.inboxGroups();
                }
                if (p['pluginId'] === 'muxr.status' && p['contributionId'] === 'vitals') {
                    return DEMO_VITALS_TEXT;
                }
                if (p['pluginId'] === 'muxr.status' && p['contributionId'] === 'usage') {
                    return { ...DEMO_USAGE_SNAPSHOT };
                }
                if (p['pluginId'] === 'muxr.code' && p['contributionId'] === 'files.repos') {
                    return { ...DEMO_FILES_REPOS };
                }
                if (p['pluginId'] === 'muxr.code' && p['contributionId'] === 'files.list') {
                    return { ...DEMO_FILES_TREE };
                }
                if (p['pluginId'] === 'muxr.servers' && p['contributionId'] === 'ports.list') {
                    return { ...DEMO_PORTS_EMPTY };
                }
                throw new Error(`unsupported in demo replay: ${type} ${String(p['contributionId'] ?? '')}`);
            }
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
            case 'session.start': {
                return this.spawnSession(p as Record<string, unknown>);
            }
            case 'session.readFile': {                if (String(p['sessionId'] ?? '') === DEMO_SESSION_DONE && String(p['path'] ?? '').endsWith(DEMO_ARTIFACT_PATH)) {
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
                // Production thumbnails render ANSI-stripped text (the host
                // strips before serving pane.read); the ANSI channel is the
                // terminal itself, which keeps its escapes untouched.
                return { text: stripTerminalEscapes((this.transcripts[sessionId] ?? []).join('\n')), truncated: false };
            }
            default:
                // Fail closed and visibly: no network fallback, no invented data.
                // Live surfaces (preview, takeover, voice) need a real computer.
                if (type.startsWith('preview.') || type.startsWith('plugin.stream') || type.startsWith('terminal.')) {
                    throw new Error('This needs a connected computer. The demo replays three scripted agents; pair your own computer to use it for real.');
                }
                throw new Error(`unsupported in demo replay: ${type}`);
        }
    }

    private agentStatus(sessionId: string): AgentLifecycle {
        if (sessionId === DEMO_SESSION_BLOCKED) {
            if (this.blockedPhase === 'working') return 'working';
            if (this.blockedPhase === 'done') return 'done';
            return 'blocked';
        }
        if (this.created.some((session) => session.id === sessionId)) return 'working';
        return sessionId === DEMO_SESSION_WORKING ? 'working' : 'done';
    }

    private isWorking(sessionId: string): boolean {
        return this.agentStatus(sessionId) === 'working';
    }

    private sessions() {
        return [...DEMO_SESSIONS, ...this.created].map((session) => {
            if (session.id !== DEMO_SESSION_BLOCKED) return session;
            const status = this.agentStatus(session.id);
            return { ...session, agentStatus: status };
        });
    }

    /**
     * Inbox rows from the same records as the herd, bucketed like the real
     * rpc.mjs: blocked attention first, then working, then recent done. When
     * the blocked agent reconciles to done the needs-you bucket empties, so
     * the badge and the collection move together.
     */
    private inboxRows(): Array<{ bucket: string; row: Record<string, unknown> }> {
        const attentionBySession = new Map(DEMO_ATTENTION.map((entry) => [entry.sessionId, entry]));
        const rows: Array<{ bucket: string; row: Record<string, unknown> }> = [];
        for (const session of this.sessions()) {
            const attention = attentionBySession.get(session.id);
            const base = {
                id: session.id,
                title: session.taskTitle,
                subtitle: attention?.detail ?? session.cwd,
                glyph: session.agentKind,
                timestamp: attention?.at ?? new Date().toISOString(),
                action: { type: 'kernel.navigate', target: 'session', sessionId: session.id },
            };
            if (session.agentStatus === 'blocked' && this.blockedPhase !== 'done') {
                rows.push({ bucket: 'needsYou', row: { ...base, status: 'danger', pulsing: true } });
            } else if (session.agentStatus === 'working') {
                rows.push({ bucket: 'working', row: { ...base, status: 'warning', pulsing: true } });
            } else if (session.agentStatus === 'done') {
                rows.push({ bucket: 'done', row: { ...base, status: 'positive' } });
            }
        }
        return rows;
    }

    private inboxGroups(): { title: string; groups: Array<{ id: string; title: string; items: unknown[] }> } {
        const groups = new Map<string, unknown[]>();
        for (const entry of this.inboxRows()) {
            const list = groups.get('acme-app') ?? [];
            list.push(entry.row);
            groups.set('acme-app', list);
        }
        return {
            title: 'Inbox',
            groups: [...groups.entries()].map(([title, items], index) => ({ id: `group-${index + 1}`, title, items })),
        };
    }

    /** Deterministic session creation through the real session.start path. */

    private spawnSession(params: Record<string, unknown>): unknown {
        // Squad starts fan out to one tab per kind on production; the replay
        // scripts a single session, so multi-kind requests fail closed and
        // visibly instead of pretending one tab is a squad.
        if (Array.isArray(params['kinds']) && params['kinds'].length > 1) {
            throw new Error('demo replay: squad start is not scripted');
        }        const id = 'demo-session-created';
        const kind = typeof params['kind'] === 'string' && params['kind'] !== '' ? params['kind'] : 'pi';
        const cwd = typeof params['cwd'] === 'string' && params['cwd'] !== '' ? params['cwd'] : '/home/demo/acme-app';
        const existing = this.created.find((session) => session.id === id);
        const session: SessionInfo = existing ?? {
            id,
            cwd,
            messageCount: 0,
            firstMessage: '',
            agentName: kind.length > 0 ? kind[0]!.toUpperCase() + kind.slice(1) : 'Agent',
            taskTitle: `New ${kind} session`,
            agentKind: kind,
            agentStatus: 'working',
            promptable: true,
        };
        if (existing === undefined) {
            this.created.push(session);
            this.transcripts[id] = [`$ new ${kind} session in ${cwd}`];
            this.emit(id, { type: 'session.created', session });
            this.emit(id, {
                type: 'status.update',
                status: statusFor(id, 'working', true, false),
            });
        }
        return {
            info: session,
            status: statusFor(id, 'working', true, false),
            page: { messages: [], hasMore: false },
        };
    }

    private tree() {
        return {
            ...DEMO_WORKSPACE,
            agentStatus: this.blockedPhase === 'done' ? 'working' as const : DEMO_WORKSPACE.agentStatus,
            tabs: DEMO_WORKSPACE.tabs.map((tab) => ({
                ...tab,
                panes: [
                    ...tab.panes.map((pane) => {
                        if (pane.sessionId === undefined || pane.sessionId !== DEMO_SESSION_BLOCKED) return pane;
                        return { ...pane, agentStatus: this.agentStatus(pane.sessionId) };
                    }),
                    // Spawned sessions join the tree like production herdr
                    // tracks them, so the session header and herd resolve.
                    ...this.created.map((session) => ({
                        paneId: `demo-pane-${session.id}`,
                        tabId: 'demo-tab-main',
                        focused: false,
                        sessionId: session.id,
                        agentName: session.agentName,
                        taskTitle: session.taskTitle,
                        agentKind: session.agentKind,
                        agentStatus: 'working' as const,
                        promptable: true,
                    })),
                ],
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
            for (const listener of [...this.transitionListeners]) listener();
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
        const generation = this.generation;
        this.timers.push(setTimeout(() => {
            if (generation === this.generation) work();
        }, ms));
    }
}

export const demoClient = new DemoClient();
