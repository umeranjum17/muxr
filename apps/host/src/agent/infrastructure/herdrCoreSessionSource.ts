/**
 * A session source that reads agents from Herdr Core (jg-kile slice 1, lab only).
 *
 * It answers list, status, open and the tree, and pushes status changes, from the terminals
 * Core reports: an agent is a terminal labelled `muxr.kind`, its space and tab are labels, its
 * status is the program's own word (see `domain/herdrCoreAgents.ts`). Start, prompt and stop
 * (jg-kile slice 6) are Core's own `terminal.run`, `terminal.send` and `terminal.kill`. The live
 * view and the rest stay unavailable until the slices that build them, and say so instead of
 * pretending. Real homes never get this source: `runHost.ts` refuses it.
 */

import type { SessionEventBody, SessionInfo } from '@trymuxr/contract';
import {
    addressFor,
    infoOf,
    isAgentTerminal,
    launchLabels,
    sessionIdFor,
    statusOf,
    treeOf,
    type CoreStatus,
    type CoreTerminal,
} from '../domain/herdrCoreAgents.js';
import type { SessionSource } from '../application/sessionSource.js';
import { connectHerdrCore, type CoreEvent, type HerdrCoreClient } from './herdrCoreClient.js';

const notYet = (what: string) => (): never => {
    throw new Error(`${what} is not built on Herdr Core yet`);
};
const notYetAsync = (what: string) => async (): Promise<never> => notYet(what)();

export interface HerdrCoreSessionSourceOptions {
    socketPath: string;
    /** The command that starts each agent kind. A kind absent here cannot be started on this Core. */
    agentCommands?: Record<string, string[]>;
    /** Receives a failure the source cannot show a caller: the event stream ending, a refresh failing. */
    onProblem?: (message: string) => void;
}

export async function createHerdrCoreSessionSource(options: HerdrCoreSessionSourceOptions): Promise<SessionSource> {
    const client: HerdrCoreClient = await connectHerdrCore(options.socketPath);
    const terminals = new Map<string, CoreTerminal>();
    const listeners = new Set<(sessionId: string, event: SessionEventBody) => void>();
    const stateSignature = new Map<string, string>();
    const infoSignature = new Map<string, string>();
    let live = true;
    let settled = Promise.resolve();

    const publish = (sessionId: string, event: SessionEventBody): void => {
        for (const listener of listeners) listener(sessionId, event);
    };
    const problem = (message: string): void => options.onProblem?.(message);

    /** Make one terminal current, saying what changed: created, status and info. */
    function upsert(terminal: CoreTerminal, announce: boolean): void {
        if (!isAgentTerminal(terminal)) { remove(terminal.address, announce); return; }
        const id = sessionIdFor(terminal.address);
        const known = terminals.has(terminal.address);
        terminals.set(terminal.address, terminal);
        const info = infoOf(terminal);
        const state = `${info.agentStatus}|${String(info.promptable)}`;
        // `modified` follows every status word; it is not news on its own.
        const signature = JSON.stringify({ ...info, modified: undefined });
        const stateChanged = stateSignature.get(id) !== state;
        const infoChanged = infoSignature.get(id) !== signature;
        stateSignature.set(id, state);
        infoSignature.set(id, signature);
        if (!announce) return;
        if (!known) { publish(id, { type: 'session.created', session: info }); return; }
        if (stateChanged) {
            publish(id, { type: 'status.update', status: statusOf(terminal) });
            publish(id, {
                type: 'activity.update',
                activity: { sessionId: id, phase: info.agentStatus === 'working' ? 'active' : 'idle', label: info.agentStatus, at: new Date().toISOString() },
            });
        }
        if (infoChanged) publish(id, { type: 'session.updated', session: info });
    }

    function remove(address: string, announce: boolean): void {
        if (!terminals.delete(address)) return;
        const id = sessionIdFor(address);
        stateSignature.delete(id);
        infoSignature.delete(id);
        if (announce) publish(id, { type: 'session.removed' });
    }

    /** Replace everything with Core's own list, announcing only the differences. */
    function replaceAll(fresh: CoreTerminal[], announce: boolean): void {
        const wanted = new Set(fresh.filter(isAgentTerminal).map((terminal) => terminal.address));
        for (const address of [...terminals.keys()]) if (!wanted.has(address)) remove(address, announce);
        for (const terminal of fresh) upsert(terminal, announce);
    }

    /** Apply one event. Status and turn carry their own facts; every other change re-reads the terminal. */
    async function apply(event: CoreEvent): Promise<void> {
        const address = event.terminal;
        if (address === undefined) return;
        if (event.type === 'removed') { remove(address, true); return; }
        const current = terminals.get(address);
        if (event.type === 'status' && current !== undefined) {
            const reported = event.data.status as CoreStatus | null | undefined;
            upsert({ ...current, reported: true, status: reported ?? null, status_ms: Date.now() }, true);
            return;
        }
        if (event.type === 'turn' && current !== undefined) {
            upsert({ ...current, turn: Number(event.data.turn ?? current.turn) }, true);
            return;
        }
        if (event.type === 'created' && !isAgentTerminal(event.data as unknown as CoreTerminal)) return;
        upsert(await client.call<CoreTerminal>('terminal.get', { terminal: address }), true);
    }

    // Events apply in the order Core sent them, one at a time.
    const enqueue = (work: () => Promise<void> | void): void => {
        settled = settled.then(work).catch((cause: unknown) => problem(`Herdr Core event not applied: ${cause instanceof Error ? cause.message : String(cause)}`));
    };
    let firstSnapshot = true;
    await client.watch({
        onSnapshot: (fresh) => {
            const announce = !firstSnapshot;
            firstSnapshot = false;
            enqueue(() => replaceAll(fresh, announce));
        },
        onEvent: (event) => enqueue(() => apply(event)),
        onClosed: (error) => { live = false; problem(error.message); },
    });
    await settled;

    const commands = options.agentCommands ?? {};
    /** Wait until Core has finished a terminal that was told to die; `terminal.rm` refuses a live one. */
    async function waitFinished(address: string): Promise<void> {
        for (let tries = 0; tries < 100; tries += 1) {
            if ((await client.call<CoreTerminal>('terminal.get', { terminal: address })).state === 'finished') return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`the agent ${address} did not stop`);
    }

    const agentOrThrow = (sessionId: string): CoreTerminal => {
        const address = addressFor(sessionId);
        const terminal = address === undefined ? undefined : terminals.get(address);
        if (terminal === undefined) throw new Error(`unknown session: ${sessionId}`);
        return terminal;
    };

    async function stopAgent(sessionId: string): Promise<{ status: 'closed' }> {
        const address = agentOrThrow(sessionId).address;
        await client.call('terminal.kill', { terminal: address });
        await waitFinished(address);
        await client.call('terminal.rm', { terminal: address });
        remove(address, true);
        return { status: 'closed' };
    }
    const all = (): CoreTerminal[] => [...terminals.values()].sort((a, b) => a.created_ms - b.created_ms);
    const infos = (): SessionInfo[] => all().map(infoOf);

    return {
        async list(listOptions = {}) {
            return infos().filter((info) => listOptions.cwd === undefined || info.cwd === listOptions.cwd);
        },
        async status(sessionId) { return statusOf(agentOrThrow(sessionId)); },
        async open(openOptions) {
            const terminal = agentOrThrow(openOptions.sessionId);
            return { info: infoOf(terminal), status: statusOf(terminal), page: { messages: [], hasMore: false } };
        },
        async herdrTree() {
            return { workspaces: treeOf(all()), connected: live };
        },
        async refreshHerdr() { replaceAll(await client.list(), true); },
        async agentKinds() { return [...new Set([...Object.keys(commands), ...infos().flatMap((info) => info.agentKind ?? [])])]; },
        async installedAgentKinds(kinds) { return kinds.filter((kind) => commands[kind] !== undefined); },
        async agentInstallStates() { return {}; },
        async applicationsList() { return { items: [] }; },
        async herdrCli() { return { stdout: '', stderr: 'the Herdr Core source has no herdr CLI', exitCode: null, timedOut: false }; },
        async paneForegroundPids() { return []; },
        async restorePaneTerminalModes() { return false; },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        async dispose() {
            live = false;
            listeners.clear();
            client.close();
        },
        async close() {
            live = false;
            listeners.clear();
            client.close();
        },

        async start(startOptions) {
            const kind = startOptions.kind ?? Object.keys(commands)[0];
            const argv = kind === undefined ? undefined : commands[kind];
            if (kind === undefined || argv === undefined) throw new Error(`Herdr Core has no way to start ${kind ?? 'an agent'} here`);
            const labels = launchLabels({ cwd: startOptions.cwd, kind, ...(startOptions.label === undefined ? {} : { label: startOptions.label }), ...(startOptions.taskTitle === undefined ? {} : { taskTitle: startOptions.taskTitle }) });
            const run = await client.call<CoreTerminal>('terminal.run', { argv, cwd: startOptions.cwd, labels, keep: true });
            upsert(run, true);
            return { info: infoOf(run), status: statusOf(run), page: { messages: [], hasMore: false } };
        },
        applicationsLaunch: notYetAsync('Applications'),
        herdrTerminal: notYet('The live terminal'),
        voiceStream: notYetAsync('Voice'),
        herdrLayout: notYetAsync('Pane layout'),
        paneSplit: notYetAsync('Splitting a pane'),
        paneRead: notYetAsync('Reading a pane'),
        paneScroll: notYetAsync('Pane scroll'),
        paneVisibleText: notYetAsync('Reading a pane'),
        agentWatch: notYetAsync('Watching an agent'),
        agentWait: notYetAsync('Waiting on an agent'),
        layoutExport: notYetAsync('Layouts'),
        layoutApply: notYetAsync('Layouts'),
        paneFocus: notYetAsync('Focusing a pane'),
        focusNeighbor: notYetAsync('Focusing a pane'),
        focusTabNeighbor: notYetAsync('Focusing a tab'),
        focusWorkspaceNeighbor: notYetAsync('Focusing a space'),
        createTab: notYetAsync('Creating a tab'),
        closeTab: notYetAsync('Closing a tab'),
        closeWorkspace: notYetAsync('Closing a space'),
        rename: notYetAsync('Renaming'),
        sendKeys: notYetAsync('Sending keys'),
        paneZoom: notYetAsync('Zooming a pane'),
        stop: stopAgent,
        // A Core terminal is its own pane, so closing the pane is stopping the agent.
        async closePane(sessionId) { await stopAgent(sessionId); },
        abort: notYetAsync('Aborting an agent'),
        reload: notYetAsync('Reloading an agent'),
        async prompt(promptOptions) {
            const terminal = agentOrThrow(promptOptions.sessionId);
            await client.call('terminal.send', { terminal: terminal.address, text: promptOptions.text });
        },
        handoff: notYetAsync('Handoff'),
        shell: notYetAsync('Running a command'),
        readFile: notYetAsync('Reading a file'),
        saveAttachments: notYetAsync('Prompt attachments'),
        artifactList: notYetAsync('Artifacts'),
        artifactFetch: notYetAsync('Artifacts'),
        artifactPrepare: notYetAsync('Artifacts'),
        artifactRead: notYetAsync('Artifacts'),
    };
}

