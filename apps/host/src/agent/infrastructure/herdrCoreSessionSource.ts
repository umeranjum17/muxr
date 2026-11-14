/**
 * A session source that reads agents from Herdr Core (jg-kile slice 1, lab only).
 *
 * It answers list, status, open and the tree, and pushes status changes, from the terminals
 * Core reports: an agent is a terminal labelled `muxr.kind`, its status is the program's own word
 * (see `domain/herdrCoreAgents.ts`). Start, prompt and stop (jg-kile slice 6) are Core's own
 * `terminal.run`, `terminal.send` and `terminal.kill`. Spaces, tabs and panes (slice 8) live in the
 * Herdr app's layout document (`domain/herdrAppLayout.ts`): the tree, rename, new tab, split and
 * close read and write it, and an unreadable document falls back to each agent's labels. The live
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
import {
    arrange,
    freeTabName,
    labelPlace,
    placementsOf,
    placeTerminal,
    removeTerminal,
    renameSpace,
    renameTab,
    splitTerminal,
    TAB_LABEL,
    SPACE_LABEL,
    type AppDocument,
    type Placement,
} from '../domain/herdrAppLayout.js';
import type { SessionSource } from '../application/sessionSource.js';
import { connectHerdrCore, type CoreEvent, type HerdrCoreClient } from './herdrCoreClient.js';
import { createLayoutStore } from './herdrCoreLayoutStore.js';

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
    const store = createLayoutStore(client);
    /** The Herdr app's layout document; `undefined` while it cannot be read, when agents are placed by their labels. */
    let layout: AppDocument | undefined;
    let placements: Map<string, Placement> | undefined;
    let live = true;
    let settled = Promise.resolve();

    const publish = (sessionId: string, event: SessionEventBody): void => {
        for (const listener of listeners) listener(sessionId, event);
    };
    const problem = (message: string): void => options.onProblem?.(message);
    const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

    const agents = (): CoreTerminal[] => [...terminals.values()].sort((a, b) => a.created_ms - b.created_ms);
    /** Where each agent sits now: the layout's word, the agent's labels where the layout is silent. */
    const placementOf = (terminal: CoreTerminal): Placement => {
        placements ??= placementsOf(arrange(layout, agents()));
        const placed = placements.get(terminal.address);
        if (placed === undefined) throw new Error(`${terminal.address} has no place in the layout`);
        return placed;
    };
    const infoFor = (terminal: CoreTerminal): SessionInfo => infoOf(terminal, placementOf(terminal));

    /** Make one terminal current, saying what changed: created, status and info. */
    function upsert(terminal: CoreTerminal, announce: boolean): void {
        if (!isAgentTerminal(terminal)) { remove(terminal.address, announce); return; }
        const id = sessionIdFor(terminal.address);
        const known = terminals.has(terminal.address);
        terminals.set(terminal.address, terminal);
        placements = undefined;
        const info = infoFor(terminal);
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
        placements = undefined;
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

    /** Read the layout document again and tell clients whose space or tab changed. A document that cannot be read means labels. */
    async function refreshLayout(): Promise<void> {
        try { layout = await store.read(); } catch (cause) { layout = undefined; problem(`Herdr Core layout not read: ${describe(cause)}`); }
        placements = undefined;
        for (const terminal of agents()) upsert(terminal, true);
    }

    /** Apply one event. Status and turn carry their own facts; every other change re-reads the terminal. */
    async function apply(event: CoreEvent): Promise<void> {
        if (event.type === 'doc') { await refreshLayout(); return; }
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
        settled = settled.then(work).catch((cause: unknown) => problem(`Herdr Core event not applied: ${describe(cause)}`));
    };
    try { layout = await store.read(); } catch (cause) { problem(`Herdr Core layout not read: ${describe(cause)}`); }
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

    /** End one agent's terminal and forget it. The layout is changed by the caller, once for everything it ended. */
    async function endAgent(address: string): Promise<void> {
        await client.call('terminal.kill', { terminal: address });
        await waitFinished(address);
        await client.call('terminal.rm', { terminal: address });
        remove(address, true);
    }
    /**
     * Change the layout document. A layout muxr cannot read is reported and left alone, and the
     * agents stay placed by their labels, because a started or ended agent is already a fact in Core.
     */
    async function changeLayout(change: (doc: AppDocument) => AppDocument): Promise<void> {
        try { layout = await store.update(agents(), change); } catch (cause) { problem(`Herdr Core layout not changed: ${describe(cause)}`); return; }
        placements = undefined;
        for (const terminal of agents()) upsert(terminal, true);
    }
    /** A structural request the caller asked for: it fails with the cause when the layout cannot be changed. */
    async function requireLayout(change: (doc: AppDocument) => AppDocument): Promise<void> {
        layout = await store.update(agents(), change);
        placements = undefined;
        for (const terminal of agents()) upsert(terminal, true);
    }

    async function stopAgent(sessionId: string): Promise<{ status: 'closed' }> {
        const address = agentOrThrow(sessionId).address;
        await endAgent(address);
        await changeLayout((doc) => removeTerminal(doc, address));
        return { status: 'closed' };
    }
    /** End every agent in `addresses`, then take them all out of the layout in one write. */
    async function endAgents(addresses: readonly string[]): Promise<void> {
        for (const address of addresses) await endAgent(address);
        await changeLayout((doc) => addresses.reduce(removeTerminal, doc));
    }
    /** Run a new agent in the anchor's space and tab (or `tab`), and place it with `place`. */
    async function runBeside(anchor: CoreTerminal, options: { kind?: string | undefined; tab?: string | undefined }, place: (doc: AppDocument, address: string) => AppDocument): Promise<CoreTerminal> {
        const kind = options.kind ?? anchor.labels['muxr.kind'];
        const argv = kind === undefined ? undefined : commands[kind];
        if (kind === undefined || argv === undefined) throw new Error(`Herdr Core has no way to start ${kind ?? 'an agent'} here`);
        const where = placementOf(anchor);
        const labels = { ...anchor.labels, 'muxr.kind': kind, [SPACE_LABEL]: where.space, [TAB_LABEL]: options.tab ?? where.tab };
        const run = await client.call<CoreTerminal>('terminal.run', { argv, cwd: anchor.cwd, labels, keep: true });
        // Placed before it is announced, so the first thing a client hears already says where it is.
        await changeLayout((doc) => place(doc, run.address));
        upsert(run, true);
        return run;
    }
    const all = agents;
    const infos = (): SessionInfo[] => all().map(infoFor);

    return {
        async list(listOptions = {}) {
            return infos().filter((info) => listOptions.cwd === undefined || info.cwd === listOptions.cwd);
        },
        async status(sessionId) { return statusOf(agentOrThrow(sessionId)); },
        async open(openOptions) {
            const terminal = agentOrThrow(openOptions.sessionId);
            return { info: infoFor(terminal), status: statusOf(terminal), page: { messages: [], hasMore: false } };
        },
        async herdrTree() {
            return { workspaces: treeOf(arrange(layout, all()), all(), placementOf), connected: live };
        },
        async refreshHerdr() { replaceAll(await client.list(), true); await refreshLayout(); },
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
            await changeLayout((doc) => placeTerminal(doc, run.address, labelPlace(run)));
            upsert(run, true);
            return { info: infoFor(run), status: statusOf(run), page: { messages: [], hasMore: false } };
        },
        applicationsLaunch: notYetAsync('Applications'),
        herdrTerminal: notYet('The live terminal'),
        voiceStream: notYetAsync('Voice'),
        herdrLayout: notYetAsync('Pane layout'),
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
        sendKeys: notYetAsync('Sending keys'),
        paneZoom: notYetAsync('Zooming a pane'),
        stop: stopAgent,
        // A Core terminal is its own pane, so closing the pane is stopping the agent.
        async closePane(sessionId) { await stopAgent(sessionId); },
        async paneSplit({ sessionId, direction, kind }) {
            const anchor = agentOrThrow(sessionId);
            // The Herdr Core lab shows agents only: "Shell (no agent)" is not built here, and is not quietly an agent instead.
            if (kind === undefined) throw new Error('A pane without an agent is not built on Herdr Core yet');
            const run = await runBeside(anchor, { kind }, (doc, address) => splitTerminal(doc, anchor.address, address, direction));
            return { paneId: run.address, sessionId: sessionIdFor(run.address) };
        },
        async createTab(sessionId, tabOptions) {
            const anchor = agentOrThrow(sessionId);
            const where = placementOf(anchor);
            const space = arrange(layout, all()).find((candidate) => candidate.id === where.spaceId);
            const wanted = tabOptions.label?.trim() || anchor.labels['muxr.kind'] || 'tab';
            const tab = freeTabName(space, wanted);
            const run = await runBeside(anchor, { kind: tabOptions.kind, tab }, (doc, address) => placeTerminal(doc, address, { space: where.space, tab, folder: anchor.cwd }));
            return { sessionId: sessionIdFor(run.address) };
        },
        async closeTab(_sessionId, tabId) {
            const tab = arrange(layout, all()).flatMap((space) => space.tabs).find((candidate) => candidate.id === tabId);
            if (tab === undefined) throw new Error('That tab is no longer available. Refresh and try again.');
            await endAgents(tab.terminals);
        },
        async closeWorkspace(workspaceId) {
            const space = arrange(layout, all()).find((candidate) => candidate.id === workspaceId);
            if (space === undefined) throw new Error('That space is no longer available. Refresh and try again.');
            await endAgents(space.tabs.flatMap((tab) => tab.terminals));
        },
        async rename(target, id, name) {
            const clean = name.trim();
            if (clean === '') throw new Error('A name cannot be empty.');
            if (target === 'workspace') await requireLayout((doc) => renameSpace(doc, id, clean));
            else if (target === 'tab') await requireLayout((doc) => renameTab(doc, id, clean));
            else throw new Error('Renaming an agent or a pane is not built on Herdr Core yet');
        },
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

