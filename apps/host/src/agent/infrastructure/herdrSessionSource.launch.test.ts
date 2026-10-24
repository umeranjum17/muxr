import { createHook } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { HostFrame, HerdrTreeWorkspace } from '@trymuxr/contract';
import { WebSocket } from 'ws';
import { DeviceLink, hostId, type DeviceGrant } from '@byokit/pair';
import { generateKeyPair } from '@trymuxr/crypto';
import { startRelay } from '@muxr/relay';
import { planAccounts } from '../../plans/planAccounts.js';
import { preparePlanSignIn } from '../../plans/planSignIn.js';
import { listPlans, planLaunchEnv } from '../../plans/plansApi.js';
import { createRequestDispatcher } from '../../requests/index.js';
import { createAgentWatchStores } from '../application/watchStores.js';
import { startHost } from '../../host.js';
import { LinkEndpoint, type MachineCryptoState } from '../../machine/index.js';
import { createHerdrSessionSource, boundedWorkspaceTokens } from './herdrSessionSource.js';
import { QUOTA_RETRY_REASON } from '../domain/quotaRetry.js';

/**
 * The slice of herdr a phone launch touches. `agent.start` answers the way
 * herdr 0.8 does: the record carries the launch name but no kind or session
 * until the process is detected, which is the boot window under test.
 */
function fakeHerdr(dir: string, cwd: string) {
    const workspaces: Array<{ workspace_id: string; label: string; worktree?: {
        repo_key?: string; repo_name?: string; checkout_path?: string; is_linked_worktree?: boolean;
    } }> = [{ workspace_id: 'w1', label: cwd }];
    const tabs: Record<string, unknown>[] = [];
    const panes: Record<string, unknown>[] = [];
    const agents: Record<string, unknown>[] = [];
    /** Like herdr, a pushed event reaches only the sockets subscribed to it; status is per pane. */
    const subscribers = new Map<Socket, Array<{ type: string; pane_id?: string }>>();
    /** Every wire method the kit sends, so a test can pin which closes a ladder issued. */
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const state: {
        failSnapshot: boolean;
        failSnapshotAfterPrompt: boolean;
        snapshotCount: number;
        holdNextSnapshot: boolean;
        releaseSnapshot?: () => void;
        holdStatusAck: boolean;
        releaseStatusAck?: () => void;
        delayAgentWaitMs: number;
        paneText: string;
        /** Every pane.send_text, so a launch's `unset` line can be read back. */
        sentTexts: string[];
        /** Fields the next started agent carries, e.g. a first-run question Herdr reports. */
        startAgentAs: Record<string, unknown>;
        /** Every agent.prompt text, delivered or not. */
        prompts: string[];
        /** Prompts the agent loses while it finishes starting; Herdr's wait reports each as stalled. */
        losePrompts: number;
        /** Screen reads that still find the agent drawing; it reads no keys until they are used up. */
        drawingReads: number;
        /** Prompts typed into the agent's input whose Enter it swallows; Herdr's wait reports each as stalled. */
        holdPrompts: number;
        /** The agent's unsubmitted input line, which a later prompt is typed onto. */
        input: string;
        /** The note a handoff turn's agent writes into its result file; unset means it writes none. */
        handoffNote?: string;
        /** The protocol `ping` reports; below 22 is a Herdr older than muxr supports. */
        protocol: number;
    } = { protocol: 22, failSnapshot: false, failSnapshotAfterPrompt: false, snapshotCount: 0, holdNextSnapshot: false, holdStatusAck: false, delayAgentWaitMs: 0, paneText: '', sentTexts: [], startAgentAs: {}, prompts: [], losePrompts: 0, drawingReads: 0, holdPrompts: 0, input: '' };
    const pendingReplies = new Set<NodeJS.Timeout>();
    const heldStatusAcks: Array<() => void> = [];
    let next = 1;
    const handleSnapshot = () => ({ snapshot: { workspaces, tabs, panes, agents } });
    const handlePluginList = () => ({ plugins: [] });
    const handleWorkspaceList = () => ({ workspaces });
    const handleTabCreate = (params: Record<string, unknown>) => {
        const tab_id = `t${next}`;
        const pane_id = `w1:p${next++}`;
        // One env per new pane: what the create carried, plus what its shell exports later.
        const env = params.env ?? {};
        tabs.push({ tab_id, workspace_id: 'w1', label: params.label ?? cwd, env });
        panes.push({ pane_id, tab_id, workspace_id: 'w1', cwd, env });
        return { tab: { tab_id }, root_pane: { pane_id } };
    };
    const handleAgentStart = (params: Record<string, unknown>) => {
        const agent = { pane_id: params.pane_id, name: params.name, agent_status: 'idle',
            ...(params.args === undefined ? {} : { args: params.args }), ...state.startAgentAs };
        agents.push(agent);
        return { agent };
    };
    const handleAgentWait = (params: Record<string, unknown>) => ({
        agent: agents.find((agent) => agent.pane_id === params.target),
    });
    /** The agent works, writes its result file where the turn asked, and goes idle. */
    const answerHandoffTurn = (paneId: string, text: string) => {
        const path = JSON.parse(/JSON file at (".+?\.json")/.exec(text)![1]!) as string;
        const turnId = JSON.parse(/"turnId":("[^"]+")/.exec(text)![1]!) as string;
        const agent = agents.find((entry) => entry.pane_id === paneId);
        const later = (run: () => void, ms: number) => {
            const timer = setTimeout(() => { pendingReplies.delete(timer); run(); }, ms);
            pendingReplies.add(timer);
        };
        later(() => {
            if (agent !== undefined) agent.agent_status = 'working';
            emitEvent('pane.agent_status_changed', { pane_id: paneId, agent_status: 'working' });
        }, 5);
        later(() => {
            if (state.handoffNote !== undefined) writeFileSync(path, JSON.stringify({ turnId, result: { note: state.handoffNote } }));
            if (agent !== undefined) agent.agent_status = 'idle';
            emitEvent('pane.agent_status_changed', { pane_id: paneId, agent_status: 'idle' });
        }, 30);
    };
    const handleAgentGet = (params: Record<string, unknown>) => {
        const agent = agents.find((entry) => entry.pane_id === params.target);
        return agent === undefined ? undefined : { agent: { interactive_ready: true, terminal_id: 'terminal-one', cwd, ...agent } };
    };
    const handleAgentPrompt = (params: Record<string, unknown>) => {
        if (state.failSnapshotAfterPrompt) state.failSnapshot = true;
        const text = String(params.text ?? '');
        state.prompts.push(text);
        if (text.includes('.byokit-turn-')) answerHandoffTurn(String(params.target), text);
        const lost = state.losePrompts > 0 || state.drawingReads > 0 || state.holdPrompts > 0;
        if (state.losePrompts > 0) state.losePrompts -= 1;
        else if (state.holdPrompts > 0) {
            state.holdPrompts -= 1;
            state.input += text;
        } else {
            state.paneText += `${state.input}${text}\n`;
            state.input = '';
        }
        // Like Herdr, only a caller that waits learns the prompt started no turn.
        if (params.wait !== undefined && lost) {
            return { error: { code: 'agent_prompt_stalled', message: 'agent prompt produced no observed working or blocked state within 5000 ms' } };
        }
        return {
            type: 'agent_prompted',
            agent: {
                terminal_id: 'terminal-one',
                agent_status: 'idle',
                workspace_id: 'w1',
                tab_id: (tabs[0]?.tab_id as string) ?? 'w1:t1',
                pane_id: params.target,
                focused: false,
                revision: 1,
            },
        };
    };
    const handlePaneClose = (paneId: unknown) => {
        const index = panes.findIndex((pane) => pane.pane_id === paneId);
        if (index !== -1) panes.splice(index, 1);
        for (let i = agents.length - 1; i >= 0; i -= 1) {
            if (agents[i]?.pane_id === paneId) agents.splice(i, 1);
        }
        return {};
    };
    // The kit's guarded closes read the live tree before closing: counts come
    // from the registries, like Herdr derives them.
    const handleTabGet = (tabId: unknown) => {
        const tab = tabs.find((entry) => entry.tab_id === tabId);
        if (tab === undefined) return { error: { code: 'tab_not_found', message: 'tab not found' } };
        return { tab: { ...tab, pane_count: panes.filter((pane) => pane.tab_id === tabId).length } };
    };
    const handleWorkspaceGet = (workspaceId: unknown) => {
        const workspace = workspaces.find((entry) => entry.workspace_id === workspaceId);
        if (workspace === undefined) return { error: { code: 'workspace_not_found', message: 'workspace not found' } };
        return { workspace: { ...workspace, tab_count: tabs.filter((tab) => tab.workspace_id === workspaceId).length } };
    };
    const dropTab = (tabId: unknown) => {
        for (let i = panes.length - 1; i >= 0; i -= 1) {
            if (panes[i]?.tab_id === tabId) handlePaneClose(panes[i]?.pane_id);
        }
        const index = tabs.findIndex((tab) => tab.tab_id === tabId);
        if (index !== -1) tabs.splice(index, 1);
    };
    const handleLayoutApply = (params: Record<string, unknown>) => {
        const tab_id = `t${next}`;
        const assign = (node: Record<string, unknown>): Record<string, unknown> => {
            if (node.type === 'split') {
                return { ...node, first: assign(node.first as Record<string, unknown>), second: assign(node.second as Record<string, unknown>) };
            }
            const pane_id = `w1:p${next++}`;
            panes.push({ pane_id, tab_id, workspace_id: 'w1', cwd, env: node.env });
            return { ...node, pane_id };
        };
        return { layout: { tab_id, root: assign((params.root ?? {}) as Record<string, unknown>) } };
    };
    const handlePaneSendText = (p: Record<string, unknown>) => {
        const text = String(p.text ?? '');
        state.sentTexts.push(text);
        const pane = panes.find((entry) => entry.pane_id === p.pane_id);
        if (pane === undefined) return {};
        const paneEnv = (pane.env ?? {}) as Record<string, string>;
        // The kit's verifying overlay: the shell sources a private file of unset/export
        // steps, then prints its marker once every step held.
        const sourced = /^set \+x \+v; \. '(.+)'$/.exec(text.trim());
        if (sourced !== null) {
            const content = readFileSync(sourced[1]!, 'utf8');
            for (const step of content.split(' &&\n').map((entry) => entry.trim())) {
                const unset = /^unset ([A-Za-z_][A-Za-z0-9_]*)$/.exec(step);
                const exported = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/s.exec(step);
                if (unset !== null) {
                    delete paneEnv[unset[1]!];
                    state.sentTexts.push(step);
                } else if (exported !== null) paneEnv[exported[1]!] = exported[2]!.replaceAll("'\\''", "'");
            }
            // A real shell prints each bare marker line the file carries: the
            // overlay's confirmation and, since kit 0.12.0, the agent hint's
            // function-plus-marker script. Without the print the kit waits out
            // its whole hint budget on every start. Every step holds here, so the
            // refusal marker after a `||` (kit 0.16.2) is never printed.
            let orElse = false;
            for (const line of content.split('\n').map((entry) => entry.trim())) {
                const marker = /^printf '%s\\n' '(.+)'( \|\|)?$/.exec(line);
                if (marker !== null && !orElse) state.paneText += `${marker[1]}\n`;
                orElse = line.endsWith('||');
            }
            return {};
        }
        if (text.startsWith('unset ')) {
            // The shell sheds the names; a later ${NAME+x} probe reads them as absent.
            for (const name of text.trim().slice('unset '.length).split(/\s+/)) delete paneEnv[name];
            return {};
        }
        // checkPaneEnv's probe: echo <marker>="$NAME" (or ${NAME+x}), answered from the pane's env.
        const probe = /^echo ([A-Za-z0-9_]+)="\$\{?([A-Za-z_][A-Za-z0-9_]*)(\+x)?\}?"?$/.exec(text.trim());
        if (probe !== null) {
            let value: string;
            if (probe[3] !== undefined) value = paneEnv[probe[2]!] === undefined ? '' : 'x';
            else value = paneEnv[probe[2]!] ?? '';
            state.paneText += `${probe[1]}=${value}\n`;
        }
        return {};
    };
    /** Like herdr, a pushed event reaches only the sockets subscribed to it. */
    const emitEvent = (type: string, data: Record<string, unknown>): void => {
        for (const [socket, subscriptions] of subscribers) {
            if (wants(subscriptions, type, data.pane_id)) socket.write(`${JSON.stringify({ event: type, data })}\n`);
        }
    };
    const server = createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                const { id, method, params } = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
                if (method === 'events.subscribe') {
                    const accept = () => {
                        subscribers.set(socket, (params?.subscriptions ?? []) as Array<{ type: string; pane_id?: string }>);
                        socket.write(`${JSON.stringify({ id, result: {} })}\n`);
                    };
                    // The kit reuses one status socket per pane with its own ids, and
                    // opens its own bootstrap watches beside muxr's discovery watch:
                    // hold every filtered agent-status subscription while held.
                    const wantsStatus = ((params?.subscriptions ?? []) as Array<{ type?: string }>)
                        .some((sub) => sub.type === 'pane.agent_status_changed');
                    if (state.holdStatusAck && wantsStatus) {
                        heldStatusAcks.push(accept);
                        state.releaseStatusAck = () => {
                            state.holdStatusAck = false;
                            for (const release of heldStatusAcks.splice(0)) release();
                        };
                    } else accept();
                    continue;
                }
                const p = params ?? {};
                calls.push({ method, params: p });
                let reply: unknown;
                switch (method) {
                    case 'ping':
                        reply = { id, result: { protocol: state.protocol } };
                        break;
                    case 'session.snapshot': {
                        state.snapshotCount += 1;
                        const result = structuredClone(handleSnapshot());
                        reply = state.failSnapshot
                            ? { id, error: { code: 'snapshot_failed', message: 'snapshot failed' } }
                            : { id, result };
                        if (state.holdNextSnapshot) {
                            state.holdNextSnapshot = false;
                            state.releaseSnapshot = () => socket.end(`${JSON.stringify(reply)}\n`);
                            continue;
                        }
                        break;
                    }
                    case 'plugin.list':
                        reply = { id, result: handlePluginList() };
                        break;
                    case 'workspace.list':
                        reply = { id, result: handleWorkspaceList() };
                        break;
                    case 'pane.get':
                        reply = { id, result: { pane: panes.find((pane) => pane.pane_id === p.pane_id) } };
                        break;
                    case 'tab.get': {
                        const answer = handleTabGet(p.tab_id);
                        reply = 'error' in answer ? { id, ...answer } : { id, result: answer };
                        break;
                    }
                    case 'workspace.get': {
                        const answer = handleWorkspaceGet(p.workspace_id);
                        reply = 'error' in answer ? { id, ...answer } : { id, result: answer };
                        break;
                    }
                    case 'worktree.create':
                        reply = { id, result: { workspace: { workspace_id: 'w1', worktree: { checkout_path: cwd } } } };
                        break;
                    case 'pane.split': {
                        const created = handleTabCreate(p);
                        reply = { id, result: { pane: created.root_pane } };
                        break;
                    }
                    case 'tab.create':
                        reply = { id, result: handleTabCreate(p) };
                        break;
                    case 'agent.start':
                        reply = { id, result: handleAgentStart(p) };
                        break;
                    case 'agent.get': {
                        const answer = handleAgentGet(p);
                        reply = answer === undefined
                            ? { id, error: { code: 'agent_not_found', message: String(p.target) } }
                            : { id, result: answer };
                        break;
                    }
                    case 'agent.wait': {
                        reply = { id, result: handleAgentWait(p) };
                        // The close test delays the reply past teardown: the
                        // watch is still in flight when close() runs, so only
                        // close() itself can release the guard.
                        if (state.delayAgentWaitMs > 0) {
                            const response = `${JSON.stringify(reply)}\n`;
                            const timer = setTimeout(() => {
                                pendingReplies.delete(timer);
                                if (!socket.destroyed) socket.end(response);
                            }, state.delayAgentWaitMs);
                            pendingReplies.add(timer);
                            continue;
                        }
                        break;
                    }
                    case 'agent.prompt': {
                        const answer = handleAgentPrompt(p);
                        reply = 'error' in answer ? { id, ...answer } : { id, result: answer };
                        break;
                    }
                    case 'agent.send_keys':
                        // A shell pane has no agent: Herdr refuses, and the
                        // kit falls back to the pane's own key path.
                        if (!agents.some((agent) => agent.pane_id === p.target)) {
                            reply = { id, error: { code: 'agent_not_found', message: 'no agent on pane' } };
                            break;
                        }
                        // The agent's own line editing: ctrl+u empties a line, backspace joins the one above.
                        for (const key of (p.keys ?? []) as string[]) {
                            if (key === 'ctrl+u') state.input = state.input.slice(0, state.input.lastIndexOf('\n') + 1);
                            else if (key === 'backspace') state.input = state.input.slice(0, -1);
                        }
                        reply = { id, result: {} };
                        break;
                    case 'pane.send_keys':
                        reply = { id, result: {} };
                        break;
                    case 'pane.read':
                        if (state.drawingReads > 0) {
                            state.drawingReads -= 1;
                            state.paneText += 'drawing\n';
                        }
                        reply = { id, result: { read: { text: state.paneText } } };
                        break;
                    case 'pane.send_text':
                        reply = { id, result: handlePaneSendText(p) };
                        break;
                    case 'tab.rename': {
                        const tab = tabs.find((entry) => entry.tab_id === p.tab_id);
                        if (tab !== undefined) tab.label = p.label;
                        reply = { id, result: {} };
                        break;
                    }
                    case 'pane.process_info':
                        // An idle shell: the kit sends shell input only to one.
                        reply = { id, result: { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'bash' }] } } };
                        break;
                    case 'pane.close':
                        reply = { id, result: handlePaneClose(p.pane_id) };
                        break;
                    case 'tab.close':
                        dropTab(p.tab_id);
                        reply = { id, result: {} };
                        break;
                    case 'workspace.close': {
                        if (p.close_group === true) {
                            const target = workspaces.find((entry) => entry.workspace_id === p.workspace_id) as
                                | { worktree?: { repo_key?: string } } | undefined;
                            const key = target?.worktree?.repo_key;
                            for (const member of workspaces.filter((entry) =>
                                key !== undefined && (entry as { worktree?: { repo_key?: string } }).worktree?.repo_key === key)) {
                                for (const tab of tabs.filter((entry) => entry.workspace_id === member.workspace_id)) {
                                    dropTab(tab.tab_id);
                                }
                                workspaces.splice(workspaces.indexOf(member), 1);
                            }
                        } else {
                            for (const tab of tabs.filter((entry) => entry.workspace_id === p.workspace_id)) {
                                dropTab(tab.tab_id);
                            }
                            const index = workspaces.findIndex((entry) => entry.workspace_id === p.workspace_id);
                            if (index !== -1) workspaces.splice(index, 1);
                        }
                        reply = { id, result: {} };
                        break;
                    }
                    case 'layout.apply':
                        reply = { id, result: handleLayoutApply(p) };
                        break;
                    default:
                        reply = { id, error: { code: 'method_not_found', message: method } };
                        break;
                }
                socket.end(`${JSON.stringify(reply)}\n`);
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => subscribers.delete(socket));
    });
    const socketPath = join(dir, 'herdr.sock');
    server.listen(socketPath);
    const wants = (subscriptions: Array<{ type: string; pane_id?: string }>, type: string, paneId: unknown) =>
        subscriptions.some((sub) => sub.type === type && (sub.pane_id === undefined || sub.pane_id === paneId));
    return {
        socketPath,
        state,
        calls,
        agents,
        tabs,
        panes,
        workspaces,
        emit: emitEvent,
        watching(type: string, paneId: string): boolean {
            return [...subscribers.values()].some((subscriptions) => wants(subscriptions, type, paneId));
        },
        close(): void {
            for (const timer of pendingReplies) clearTimeout(timer);
            pendingReplies.clear();
            for (const socket of subscribers.keys()) socket.destroy();
            server.close();
        },
    };
}

function treePane(tree: { workspaces: HerdrTreeWorkspace[] }, paneId: string) {
    const pane = tree.workspaces.flatMap((ws) => ws.tabs).flatMap((tab) => tab.panes).find((row) => row.paneId === paneId);
    if (pane === undefined) throw new Error(`pane ${paneId} missing from herdr.tree`);
    return pane;
}

describe('phone launch before herdr detects the agent', () => {
    it('delivers retired launch failures on reconnect until their own pane closes or recovers', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-reconnect-'));
        const herdr = fakeHerdr(dir, dir);
        const domain = createAgentWatchStores({ dataDir: join(dir, 'host') });
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath, dataDir: join(dir, 'host'),
            artifactsDir: join(dir, 'artifacts'), hostHttpPort: 0,
            machineName: 'Umer', attention: domain.attention, lifecycle: domain.lifecycle,
        });
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay'), advertiseMdns: false } });
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const host = startHost({ source, domain, relayUrl, machineId: 'launch-lab', machineName: 'Umer', stateRoot: join(dir, 'host') });
        const machine = generateKeyPair();
        const phone = generateKeyPair();
        const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64');
        const b64url = (value: string): string => Buffer.from(value, 'base64').toString('base64url');
        const crypto: MachineCryptoState = {
            signingPublicKey: b64(new Uint8Array(32)), signingSecretKey: b64(new Uint8Array(64)),
            boxPublicKey: machine.publicKey, boxSecretKey: machine.secretKey,
            dataKey: b64(new Uint8Array(32)), keyVersion: 1,
            devices: [{ deviceId: 'fixture-phone', devicePublicKey: phone.publicKey,
                ingressKey: b64(new Uint8Array(32)), authority: 'control',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
        };
        const linkStates = new Map<string, boolean>();
        const endpoint = await LinkEndpoint.open({
            relayUrl, machineName: 'Umer', crypto, currentCrypto: () => crypto,
            // This is only the newly created private relay's fixture enrolment.
            ownerToken: JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string,
            savePushLevel: () => undefined, grants: { load: () => [], save: () => undefined },
            answer: host.answer, canView: host.canView,
            onDeviceConnection: (id, active) => { linkStates.set(id, active); host.setLinkDeviceConnection(id, active); },
        });
        host.onBroadcast((frame, deviceId) => endpoint!.broadcast(frame, deviceId));
        endpoint!.start();
        const grant: DeviceGrant = {
            v: 1, secretKey: b64url(phone.secretKey), host: b64url(machine.publicKey), hostName: 'Umer',
            urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(Buffer.from(machine.publicKey, 'base64'))}`],
            device: { id: '', name: 'Fixture phone', role: 'control' },
        };
        let phoneLink: DeviceLink | undefined;
        let delivered: HostFrame[] = [];
        let admissionErrors: HostFrame[] = [];
        const connect = async () => {
            delivered = [];
            phoneLink = new DeviceLink(grant, { WebSocket, onEvent: (value) => delivered.push(value as HostFrame) });
            await vi.waitFor(() => expect(phoneLink!.status).toBe('online'), { timeout: 15_000 });
            await vi.waitFor(() => expect(linkStates.get('fixture-phone')).toBe(true), { timeout: 5_000 });
            await phoneLink.request('machine.hello', { type: 'machine.hello', requestId: 'fixture-handshake', params: {} });
            admissionErrors = delivered.filter((frame) => frame.type === 'session.event' && frame.event.type === 'session.error');
            await phoneLink.request('session.list', { type: 'session.list', requestId: 'fixture-catalog', params: {} });
        };
        let requestSeq = 0;
        const start = async () => {
            const result = await phoneLink!.request('session.start', {
                type: 'session.start', requestId: `launch-${++requestSeq}`, params: { cwd: dir, kind: 'pi' },
            }) as { ok: boolean; data?: { info: { id: string } } };
            expect(result.ok).toBe(true);
            return result.data!.info.id;
        };
        const errors = (id: string) => delivered.filter((frame) => frame.type === 'session.event'
            && frame.sessionId === id && frame.event.type === 'session.error');
        const fail = async (pane: string) => {
            herdr.state.paneText = 'bash: pi: command not found\n';
            const index = herdr.agents.findIndex((agent) => agent.pane_id === pane);
            herdr.agents.splice(index, 1);
            await source.refreshHerdr();
        };
        try {
            await connect();
            const connectedId = await start();
            await source.refreshHerdr();
            await fail('w1:p1');
            await vi.waitFor(() => expect(errors(connectedId)).toHaveLength(1));
            expect(errors(connectedId)[0]).toMatchObject({ event: { message: 'Pi is not installed on Umer. Install Pi in a terminal on Umer, then try again.' } });

            const disconnectedId = await start();
            await source.refreshHerdr();
            phoneLink!.stop();
            await vi.waitFor(() => expect(linkStates.get('fixture-phone')).toBe(false), { timeout: 5_000 });
            await fail('w1:p2');
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(connectedId);
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(disconnectedId);
            await connect();
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(connectedId);
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(disconnectedId);
            // Admission delivers the original-route error before a catalog can follow its shell.
            expect(errors(disconnectedId)).toHaveLength(1);
            expect(admissionErrors).toContainEqual(expect.objectContaining({ sessionId: disconnectedId }));
            expect(treePane(await source.herdrTree(), 'w1:p2')).toMatchObject({ sessionId: 'shell:w1:p2', promptable: false });

            // Closing one failed pane cannot erase the other pane's explanation.
            herdr.panes.splice(herdr.panes.findIndex((pane) => pane.pane_id === 'w1:p1'), 1);
            phoneLink!.stop();
            await connect();
            expect(errors(connectedId)).toHaveLength(0);
            expect(errors(disconnectedId)).toHaveLength(1);
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(connectedId);
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(disconnectedId);

            // A detected, ready replacement on that same pane ends its retired failure.
            herdr.agents.push({ pane_id: 'w1:p2', name: 'Umer', agent: 'pi', agent_status: 'idle', interactive_ready: true,
                agent_session: { source: 'herdr', agent: 'pi', kind: 'id', value: 'recovered-pi' } });
            phoneLink!.stop();
            await connect();
            expect(treePane(await source.herdrTree(), 'w1:p2')).toMatchObject({ agentKind: 'pi', promptable: true });
            expect(errors(disconnectedId)).toHaveLength(0);
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).not.toContain(disconnectedId);

            const successfulId = await start();
            Object.assign(herdr.agents.find((agent) => agent.pane_id === 'w1:p3')!, {
                agent: 'pi', agent_status: 'idle', interactive_ready: true,
                agent_session: { source: 'herdr', agent: 'pi', kind: 'id', value: 'successful-pi' },
            });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p3', agent: 'pi' });
            await source.refreshHerdr();
            phoneLink!.stop();
            await connect();
            expect(treePane(await source.herdrTree(), 'w1:p3')).toMatchObject({ sessionId: successfulId, promptable: true });
            expect(domain.unread.catalog().entries.map((entry) => entry.sessionId)).toContain(successfulId);
            expect(delivered.filter((frame) => frame.type === 'session.event' && frame.event.type === 'session.error')).toEqual([]);
        } finally {
            phoneLink?.stop(); endpoint?.close(); await host.close();
            await source.dispose(); await domain.dispose();
            await relay.close(); herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    it('keeps the requested kind through the boot window and drops it once the launch gives up', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const removedSessions: string[] = [];
        const unsubscribe = source.subscribe((sessionId, event) => {
            if (event.type === 'session.removed') removedSessions.push(sessionId);
        });
        try {
            const started = await source.start({ cwd, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            const sessionId = started.info.id;

            // Herdr's own snapshot has replaced the seeded record: launch name, no kind yet.
            await source.refreshHerdr();
            expect(herdr.agents[0]).toEqual({ pane_id: 'w1:p1', name: expect.stringMatching(/^pp_/), agent_status: 'idle' });
            expect(herdr.tabs[0]?.env).toMatchObject({ MUXR_AGENT_CAPABILITIES: expect.stringContaining('muxr share <path>') });
            let pane = treePane(await source.herdrTree(), 'w1:p1');
            expect(pane).toMatchObject({ agentKind: 'claude', sessionId });
            expect(pane.agentName).toBeUndefined();

            // Detection: herdr publishes the kind and its own session; the route survives adoption.
            Object.assign(herdr.agents[0]!, {
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-1' },
            });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();
            pane = treePane(await source.herdrTree(), 'w1:p1');
            expect(pane).toMatchObject({ agentKind: 'claude', sessionId });

            // Codex 0.159: herdr detects the kind but never publishes a session. The launch still confirms on its route.
            const codex = await source.start({ cwd, kind: 'codex' });
            if (!('info' in codex)) throw new Error('launch rejected');
            Object.assign(herdr.agents[1]!, { agent: 'codex' });
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const launched = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => launched + 61_000);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            vi.restoreAllMocks();
            await source.refreshHerdr();
            expect(treePane(await source.herdrTree(), 'w1:p2')).toMatchObject({ agentKind: 'codex', sessionId: codex.info.id, promptable: true });
            expect(removedSessions).not.toContain(codex.info.id);

            // A launch herdr never detects: the stand-in kind expires with the launch window,
            // and a later refresh (which rehydrates the pending launch from its route) cannot revive it.
            const failed = await source.start({ cwd, kind: 'codex' });
            if (!('info' in failed)) throw new Error('launch rejected');
            await source.refreshHerdr();
            expect(treePane(await source.herdrTree(), 'w1:p3').agentKind).toBe('codex');
            const now = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => now + 300_000);
            expect(treePane(await source.herdrTree(), 'w1:p3').agentKind).toBeUndefined();
            await source.refreshHerdr();
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(removedSessions).toContain(failed.info.id);
            expect(treePane(await source.herdrTree(), 'w1:p3').agentKind).toBeUndefined();
            expect(treePane(await source.herdrTree(), 'w1:p1').agentKind).toBe('claude');
        } finally {
            unsubscribe();
            vi.restoreAllMocks();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('keeps a launch waiting on the folder-trust question past the launch deadline', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-trust-'));
        const herdr = fakeHerdr(dir, dir);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath, dataDir: join(dir, 'data'), artifactsDir: join(dir, 'attachments'), hostHttpPort: 0,
        });
        const events: string[] = [];
        const unsubscribe = source.subscribe((_sessionId, event) => { events.push(event.type); });
        try {
            // Claude Code asks "Is this a project you trust?" before its prompt: Herdr
            // reports it blocked and still launch-pending until the person answers.
            herdr.state.startAgentAs = { agent: 'claude', agent_status: 'blocked', launch_pending: true };
            const started = await source.start({ cwd: dir, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const launched = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => launched + 61_000);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            vi.restoreAllMocks();
            await source.refreshHerdr();
            expect(events).not.toContain('session.error');
            expect(events).not.toContain('session.removed');
            expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ sessionId: started.info.id, promptable: false });
        } finally {
            unsubscribe();
            vi.restoreAllMocks();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('reads a quota retry loop as needing attention instead of idle, and releases it when the loop ends', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-quota-'));
        const herdr = fakeHerdr(dir, dir);
        const domain = createAgentWatchStores({ dataDir: join(dir, 'host') });
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath, dataDir: join(dir, 'host'),
            artifactsDir: join(dir, 'artifacts'), hostHttpPort: 0,
            machineName: 'Umer', attention: domain.attention, lifecycle: domain.lifecycle,
        });
        try {
            const started = await source.start({ cwd: dir, kind: 'pi' });
            if (!('info' in started)) throw new Error('launch rejected');
            const sessionId = started.info.id;
            // Herdr detects the agent and settles it to idle while its pane
            // keeps looping on plan/quota retries.
            Object.assign(herdr.agents.find((agent) => agent.pane_id === 'w1:p1')!, {
                agent: 'pi', name: 'quota-pi', agent_status: 'idle', interactive_ready: true,
                agent_session: { source: 'herdr', agent: 'pi', kind: 'id', value: 'quota-pi' },
            });
            herdr.state.paneText = [
                'quota exceeded for plan Work - retrying in 60s (attempt 1)',
                'quota exceeded for plan Work - retrying in 60s (attempt 2)',
            ].join('\n');
            // Adopt the published agent first, then report the loop: the probe
            // runs from the session's own state emission.
            await source.refreshHerdr();
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();
            await vi.waitFor(async () => {
                expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ sessionId, agentStatus: 'blocked' });
            }, { timeout: 15_000 });
            expect((await source.status(sessionId)).agentStatus).toBe('blocked');
            await vi.waitFor(() => {
                expect(domain.attention.catalog().entries).toContainEqual(
                    expect.objectContaining({ sessionId, reason: 'waiting', detail: QUOTA_RETRY_REASON }),
                );
            }, { timeout: 15_000 });
            expect(QUOTA_RETRY_REASON).not.toMatch(/pp_|429|ERR_|herdr/i);
            expect(domain.lifecycle.latestFor(sessionId)?.state).toBe('blocked');

            // The loop ends: output without the retry pattern releases the
            // hold on its own, past one probe window.
            herdr.state.paneText = 'done: all tasks complete\n';
            const probed = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => probed + 21_000);
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();
            vi.restoreAllMocks();
            await vi.waitFor(async () => {
                expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ sessionId, agentStatus: 'idle' });
            }, { timeout: 15_000 });
            expect(domain.attention.catalog().entries.map((entry) => entry.sessionId)).not.toContain(sessionId);
        } finally {
            vi.restoreAllMocks();
            await source.dispose();
            await domain.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

describe('new panes share the host desktop', () => {
    it('never hands a portal-selected desktop an X display, and keeps Wayland when present', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-portal-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        vi.stubEnv('MUXR_DESKTOP_SOURCE', 'portal');
        vi.stubEnv('DISPLAY', ':42');
        vi.stubEnv('WAYLAND_DISPLAY', '');
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const headless = await source.start({ cwd, kind: 'claude' });
            if (!('info' in headless)) throw new Error('launch rejected');
            const headlessEnv = herdr.panes.at(-1)?.env as Record<string, string>;
            expect(headlessEnv).not.toHaveProperty('DISPLAY');
            expect(headlessEnv.MUXR_AGENT_CAPABILITIES).toContain('run browsers headless');

            vi.stubEnv('WAYLAND_DISPLAY', 'wayland-lab');
            const wayland = await source.start({ cwd, kind: 'claude' });
            if (!('info' in wayland)) throw new Error('launch rejected');
            const waylandEnv = herdr.panes.at(-1)?.env as Record<string, string>;
            expect(waylandEnv).toMatchObject({ WAYLAND_DISPLAY: 'wayland-lab' });
            expect(waylandEnv).not.toHaveProperty('DISPLAY');
        } finally {
            vi.unstubAllEnvs();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('keeps the desktop environment through start, split, worktree, restore and tab creation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-launch-desktop-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        vi.stubEnv('DISPLAY', ':42');
        vi.stubEnv('WAYLAND_DISPLAY', 'wayland-lab');
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const checkDesktop = (env: unknown) => {
            expect(env).toMatchObject({ DISPLAY: ':42' });
            expect(env).not.toHaveProperty('WAYLAND_DISPLAY');
            const values = env as Record<string, string>;
            expect(values.MUXR_AGENT_CAPABILITIES).toContain("that desktop's browser");
            expect(values.MUXR_AGENT_CAPABILITIES).not.toContain('own screen');
        };
        try {
            const agent = await source.start({ cwd, kind: 'claude' });
            if (!('info' in agent)) throw new Error('launch rejected');
            checkDesktop(herdr.panes[0]?.env);

            const split = await source.paneSplit({ sessionId: agent.info.id, direction: 'right', kind: 'claude' });
            checkDesktop(herdr.panes.find((pane) => pane.pane_id === split.paneId)?.env);

            const worktree = await source.start({ cwd, kind: 'claude', worktree: { branch: 'desktop-lab' } });
            if (!('info' in worktree)) throw new Error('worktree launch rejected');
            checkDesktop(herdr.tabs.at(-1)?.env);

            const applied = await source.layoutApply({
                sessionId: agent.info.id,
                snapshot: {
                    type: 'split', direction: 'right', ratio: 0.5,
                    first: { type: 'pane', kind: 'claude' },
                    second: { type: 'pane' },
                },
            });
            expect(applied.started).toBe(1);
            for (const pane of herdr.panes.slice(-2)) checkDesktop(pane.env);

            await source.createTab(agent.info.id, { kind: 'claude' });
            checkDesktop(herdr.tabs.at(-1)?.env);
        } finally {
            vi.unstubAllEnvs();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('start rollback and worktree-group close ride the kit ladder', () => {
    it('a shell start that fails mid-ladder closes only the tab it created', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-ladder-rollback-'));
        const herdr = fakeHerdr(dir, dir);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const first = await source.start({ cwd: dir, kind: 'shell' });
            if (!('info' in first)) throw new Error('first shell start rejected');
            const firstPane = first.info.id.slice('shell:'.length);
            const tabsBefore = herdr.tabs.map((tab) => tab.tab_id);

            // The tab exists, then the post-place snapshot read fails: the
            // start fails mid-ladder and the kit's confirmed closes roll back.
            herdr.state.failSnapshot = true;
            const failed = await source.start({ cwd: dir, kind: 'shell' });
            herdr.state.failSnapshot = false;
            expect('info' in failed).toBe(false);
            if ('info' in failed) throw new Error('failed start returned a session');
            expect(failed.acceptance).toMatchObject({ outcome: 'failed', code: 'start-launch-failed' });

            // One tab close for the created tab; no pane, tab or workspace
            // close touches the first shell.
            const closes = herdr.calls.filter((call) =>
                call.method === 'pane.close' || call.method === 'tab.close' || call.method === 'workspace.close');
            expect(closes).toHaveLength(1);
            expect(closes[0]?.method).toBe('tab.close');
            const closedTab = (closes[0]?.params as { tab_id?: string }).tab_id;
            expect(tabsBefore).not.toContain(closedTab);

            // The first shell is still listed; the failed start left no pane.
            await source.refreshHerdr();
            expect(treePane(await source.herdrTree(), firstPane)).toMatchObject({ sessionId: first.info.id });
            expect(herdr.panes.some((pane) => pane.tab_id === closedTab)).toBe(false);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    it('stop walks pane, tab, workspace and worktree-group confirmation before the atomic group close', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-ladder-group-'));
        const herdr = fakeHerdr(dir, dir);
        // A worktree group: w1 roots lab-repo, w2 is its linked checkout.
        Object.assign(herdr.workspaces[0]!, {
            label: 'Work',
            worktree: { repo_key: 'lab-repo', repo_name: 'lab-repo', is_linked_worktree: false },
        });
        herdr.workspaces.push({
            workspace_id: 'w2', label: 'Linked',
            worktree: { repo_key: 'lab-repo', repo_name: 'lab-repo', is_linked_worktree: true },
        });
        herdr.tabs.push(
            { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' },
            { tab_id: 'w2:t1', workspace_id: 'w2', label: 'linked' },
        );
        herdr.panes.push(
            { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: dir },
            { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2', cwd: dir },
        );
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            await source.refreshHerdr();
            expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ sessionId: 'shell:w1:p1' });

            // Each rung refuses with the next scope; nothing closes until the group is confirmed.
            await expect(source.stop('shell:w1:p1', {})).resolves.toMatchObject({ status: 'confirmationRequired', scope: 'tab' });
            await expect(source.stop('shell:w1:p1', { confirmedScope: 'tab' }))
                .resolves.toMatchObject({ status: 'confirmationRequired', scope: 'workspace' });
            await expect(source.stop('shell:w1:p1', { confirmedScope: 'workspace' }))
                .resolves.toMatchObject({ status: 'confirmationRequired', scope: 'worktreeGroup', label: 'lab-repo' });
            expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ sessionId: 'shell:w1:p1' });
            expect(treePane(await source.herdrTree(), 'w2:p1')).toMatchObject({ sessionId: 'shell:w2:p1' });

            // The confirmed group close is one atomic workspace.close; no
            // member closes one by one first.
            await expect(source.stop('shell:w1:p1', { confirmedScope: 'worktreeGroup' })).resolves.toEqual({ status: 'closed' });
            expect(herdr.calls.filter((call) =>
                call.method === 'pane.close' || call.method === 'tab.close' || call.method === 'workspace.close')).toEqual([
                { method: 'workspace.close', params: { workspace_id: 'w1', close_group: true } },
            ]);
            await source.refreshHerdr();
            expect((await source.herdrTree()).workspaces).toEqual([]);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('agent started at the desk in an existing pane', () => {
    it('lists the agent once its first turn reports a session, without a host restart', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-desk-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        herdr.tabs.push({ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' });
        herdr.panes.push({ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd });
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ sessionId: 'shell:w1:p1' });
            // A shell pane has no agent, so the kit lands the abort on the pane itself.
            await source.abort('shell:w1:p1');
            expect(herdr.calls.filter((call) => call.method.endsWith('send_keys')).map((call) => [call.method, call.params.keys]))
                .toEqual([['agent.send_keys', ['escape']], ['pane.send_keys', ['escape']]]);

            // Codex starts in the shell. Herdr detects its kind and name, but
            // Codex has no session until its first turn.
            herdr.state.holdStatusAck = true;
            herdr.agents.push({ pane_id: 'w1:p1', agent: 'codex', name: 'ram', agent_status: 'idle' });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1', agent: 'codex' });
            await vi.waitFor(() => expect(herdr.state.releaseStatusAck).toBeDefined(), { timeout: 3_000 });
            await new Promise((resolve) => setTimeout(resolve, 600));

            // The first turn: Herdr takes the session report with no bus
            // event, so the pane's status watch is the only frame that moves.
            Object.assign(herdr.agents[0]!, {
                agent_status: 'done',
                agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'codex-1' },
            });
            herdr.emit('pane.agent_status_changed', { pane_id: 'w1:p1', agent: 'codex', agent_status: 'done' });
            herdr.state.releaseStatusAck?.();
            await vi.waitFor(async () => {
                expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({
                    agentKind: 'codex',
                    agentName: 'ram',
                    agentStatus: 'done',
                    sessionId: expect.stringMatching(/^pp_/),
                });
            }, { timeout: 3_000 });
            await new Promise((resolve) => setTimeout(resolve, 600));
            const reads = herdr.state.snapshotCount;
            herdr.emit('pane.agent_status_changed', { pane_id: 'w1:p1', agent: 'codex', agent_status: 'working' });
            await vi.waitFor(async () => expect(treePane(await source.herdrTree(), 'w1:p1').agentStatus).toBe('working'));
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(herdr.state.snapshotCount).toBe(reads);

            herdr.calls.length = 0;
            await source.abort(treePane(await source.herdrTree(), 'w1:p1').sessionId!);
            expect(herdr.calls.filter((call) => call.method.endsWith('send_keys')).map((call) => [call.method, call.params.keys]))
                .toEqual([['agent.send_keys', ['escape']]]);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('reads again when a missing session appears during an older snapshot', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-desk-snapshot-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        herdr.tabs.push({ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' });
        herdr.panes.push({ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd });
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            herdr.agents.push({ pane_id: 'w1:p1', agent: 'codex', name: 'ram', agent_status: 'idle' });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1', agent: 'codex' });
            await vi.waitFor(() => expect(herdr.watching('pane.agent_status_changed', 'w1:p1')).toBe(true));
            await new Promise((resolve) => setTimeout(resolve, 600));

            herdr.state.holdNextSnapshot = true;
            const stale = source.refreshHerdr();
            await vi.waitFor(() => expect(herdr.state.releaseSnapshot).toBeDefined());
            Object.assign(herdr.agents[0]!, {
                agent_status: 'done',
                agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'codex-1' },
            });
            herdr.emit('pane.agent_status_changed', { pane_id: 'w1:p1', agent_status: 'done' });
            await new Promise((resolve) => setTimeout(resolve, 600));
            herdr.state.releaseSnapshot?.();
            await stale;
            await vi.waitFor(async () => {
                expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({
                    agentKind: 'codex', sessionId: expect.stringMatching(/^pp_/),
                });
            }, { timeout: 3_000 });
        } finally {
            herdr.state.releaseSnapshot?.();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('adopts two desk-detected conversations and a sessionless desk agent', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-desk-herd-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        herdr.tabs.push({ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' });
        herdr.panes.push({ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd });
        herdr.panes.push({ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', cwd });
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            // Two detections back to back: each detection bootstrap's snapshot
            // carries both conversations, so both routes bind with no phone
            // pull between or after them.
            herdr.agents.push({ pane_id: 'w1:p1', agent: 'codex', name: 'ram', agent_status: 'idle',
                agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'codex-1' } });
            herdr.agents.push({ pane_id: 'w1:p2', agent: 'pi', name: 'magpie', agent_status: 'idle',
                agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'pi-1' } });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1', agent: 'codex' });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p2', agent: 'pi' });
            await vi.waitFor(async () => {
                expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ agentKind: 'codex', sessionId: expect.stringMatching(/^pp_/) });
                expect(treePane(await source.herdrTree(), 'w1:p2')).toMatchObject({ agentKind: 'pi', sessionId: expect.stringMatching(/^pp_/) });
            }, { timeout: 3_000 });

            // A sessionless desk agent: the kit re-reads it on each status push until its session lands; the host does not re-read.
            herdr.panes.push({ pane_id: 'w1:p3', tab_id: 'w1:t1', workspace_id: 'w1', cwd });
            herdr.agents.push({ pane_id: 'w1:p3', agent: 'codex', name: 'wren', agent_status: 'idle' });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p3', agent: 'codex' });
            await vi.waitFor(async () => expect(treePane(await source.herdrTree(), 'w1:p3').agentKind).toBe('codex'), { timeout: 3_000 });
            Object.assign(herdr.agents.at(-1)!, {
                agent_status: 'done',
                agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'codex-3' },
            });
            herdr.emit('pane.agent_status_changed', { pane_id: 'w1:p3', agent: 'codex', agent_status: 'done' });
            await vi.waitFor(async () => expect(treePane(await source.herdrTree(), 'w1:p3')).toMatchObject({
                agentKind: 'codex', agentStatus: 'done', sessionId: expect.stringMatching(/^pp_/),
            }), { timeout: 3_000 });
            expect(treePane(await source.herdrTree(), 'w1:p1')).toMatchObject({ agentKind: 'codex', sessionId: expect.stringMatching(/^pp_/) });
            expect(treePane(await source.herdrTree(), 'w1:p2')).toMatchObject({ agentKind: 'pi', sessionId: expect.stringMatching(/^pp_/) });
            expect(treePane(await source.herdrTree(), 'w1:p3')).toMatchObject({ agentKind: 'codex' });
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('realtime prompt boundary', () => {
    it('rejects unresolved targets and reports an unknown outcome when fresh confirmation fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-prompt-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const started = await source.start({ cwd, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            // A pane started by hand in Herdr: the kit reports interactive_ready=false for it.
            Object.assign(herdr.agents[0]!, {
                interactive_ready: false,
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-1' },
            });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();

            // The route never resolved, so nothing could have been sent.
            await expect(source.prompt({ sessionId: 'pp_missing', text: 'hello' }))
                .rejects.toMatchObject({ code: 'prompt-not-sent' });
            await expect(source.prompt({ sessionId: started.info.id, text: 'hello' })).resolves.toBeUndefined();

            // The prompt was accepted, but a failed fresh confirmation is ambiguous.
            herdr.state.failSnapshotAfterPrompt = true;
            await expect(source.prompt({ sessionId: started.info.id, text: 'again' }))
                .rejects.toMatchObject({ code: 'prompt-outcome-unknown' });
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('first prompt to a just-started agent', () => {
    it('types it once the screen settles, and clears one the agent leaves unsubmitted before reporting it not sent', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-first-prompt-'));
        const cwd = join(dir, 'repo');
        // A bare launch probes the host's own opencode for a version; keep it on
        // a fake so the test never runs the machine's real binary.
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, 'opencode'), 0o755);
        const savedPath = process.env.PATH;
        process.env.PATH = `${bin}:${savedPath ?? ''}`;
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const started = await source.start({ cwd, kind: 'opencode' });
            if (!('info' in started)) throw new Error('launch rejected');
            Object.assign(herdr.agents[0]!, {
                agent: 'opencode',
                agent_session: { source: 'herdr', agent: 'opencode', kind: 'id', value: 'opencode-1' },
            });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();

            // The first prompt waits out an agent still drawing, is typed once and delivered.
            herdr.state.drawingReads = 3;
            await expect(source.prompt({ sessionId: started.info.id, text: 'What does calc.py do?', firstPrompt: true })).resolves.toBeUndefined();
            expect(herdr.state.prompts).toEqual(['What does calc.py do?']);
            expect(herdr.state.paneText).toContain('What does calc.py do?');

            // A first prompt the agent leaves unsubmitted is reported as not sent and never typed again;
            // its input is cleared first, so the phone's resend reaches the agent as one copy.
            herdr.state.holdPrompts = 1;
            await expect(source.prompt({ sessionId: started.info.id, text: 'Run the tests\nthen lint', firstPrompt: true }))
                .rejects.toMatchObject({ code: 'prompt-not-sent' });
            expect(herdr.state.prompts.filter((text) => text === 'Run the tests\nthen lint')).toHaveLength(1);
            expect(herdr.state.input).toBe('');
            await expect(source.prompt({ sessionId: started.info.id, text: 'Run the tests\nthen lint' })).resolves.toBeUndefined();
            expect(herdr.state.paneText.split('Run the tests').length - 1).toBe(1);

            // An ordinary send takes the single-call path: no receipt wait, so a dropped one is not reported.
            // A title tick has just moved the tree: the send still types at once, routed on the live tree.
            // Only the confirming read follows, as this agent's receipt does not name its conversation.
            herdr.emit('pane.updated', { pane_id: 'w1:p1', pane: { pane_id: 'w1:p1', terminal_title_stripped: 'Umer is reading calc.py' } });
            await new Promise((resolve) => setTimeout(resolve, 50));
            herdr.calls.length = 0;
            herdr.state.losePrompts = 1;
            await expect(source.prompt({ sessionId: started.info.id, text: 'Ordinary send' })).resolves.toBeUndefined();
            expect(herdr.state.prompts.filter((text) => text === 'Ordinary send')).toHaveLength(1);
            expect(herdr.calls.map((call) => call.method).filter((method) => method === 'session.snapshot' || method === 'agent.prompt'))
                .toEqual(['agent.prompt', 'session.snapshot']);
        } finally {
            if (savedPath === undefined) delete process.env.PATH;
            else process.env.PATH = savedPath;
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('session list on a snapshot failure', () => {
    it('keeps the runtime online and the cached sessions visible', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-list-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const started = await source.start({ cwd, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            await source.refreshHerdr();
            expect((await source.herdrTree()).connected).toBe(true);

            // One failed snapshot keeps the cached tree and the healthy event
            // socket's connected state, instead of reporting the runtime down.
            herdr.state.failSnapshot = true;
            const duringFailure = await source.list();
            expect(duringFailure.map((session) => session.id)).toContain(started.info.id);
            expect((await source.herdrTree()).connected).toBe(true);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

// Producer tokens cross from Herdr plugins to the phone, so the bound is a trust boundary.
it('bounds workspace tokens: known keys only, capped count, sanitized capped values', () => {
    expect(boundedWorkspaceTokens({ parent: 'w1R4', kind: 'task', projection: '8NwSBmQ5YerlAcFOBfSrqg' }))
        .toEqual({ parent: 'w1R4', kind: 'task', projection: '8NwSBmQ5YerlAcFOBfSrqg' });
    expect(boundedWorkspaceTokens({ Bad: 'x', '9lead': 'x', Upper: 'x', ok_key: 'kept' })).toEqual({ ok_key: 'kept' });
    expect(boundedWorkspaceTokens(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']))))
        .toHaveProperty('k7');
    expect(Object.keys(boundedWorkspaceTokens(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'])))!)).toHaveLength(8);
    const long = boundedWorkspaceTokens({ parent: 'w'.repeat(200) })!;
    expect(long.parent!.length).toBeLessThanOrEqual(64);
    expect(boundedWorkspaceTokens({ parent: 'a\u000Bb\uFEFFc' })).toEqual({ parent: 'abc' });
    expect(boundedWorkspaceTokens(undefined)).toBeUndefined();
    expect(boundedWorkspaceTokens(['not', 'an', 'object'])).toBeUndefined();
});

describe('herdr installed in its own folder, off the host PATH', () => {
    it('is found and run at its exact path, including one installed after the host started', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-herdr-folder-'));
        const installDir = join(dir, 'bin');
        mkdirSync(installDir);
        const binary = join(installDir, 'herdr');
        const saved = { HOME: process.env.HOME, PATH: process.env.PATH, HERDR_INSTALL_DIR: process.env.HERDR_INSTALL_DIR, HERDR_BIN: process.env.HERDR_BIN, MUXR_DESKTOP_APP: process.env.MUXR_DESKTOP_APP };
        process.env.HOME = dir;
        process.env.PATH = join(dir, 'empty-path');
        mkdirSync(process.env.PATH);
        process.env.HERDR_INSTALL_DIR = installDir;
        process.env.MUXR_DESKTOP_APP = '1';
        delete process.env.HERDR_BIN;
        let source: Awaited<ReturnType<typeof createHerdrSessionSource>> | undefined;
        try {
            source = await createHerdrSessionSource({
                socketPath: join(dir, 'no-herdr.sock'), dataDir: join(dir, 'data'),
                artifactsDir: join(dir, 'attachments'), hostHttpPort: 0,
            });
            const none = await source.herdrTree();
            expect(none.missing).toBe(true);
            expect(none.desktopApp).toBe(true);
            // A Herdr older than muxr supports is not a restart: the phone leads with the install.
            writeFileSync(binary, '#!/bin/sh\n# an older release\ncase "$1" in --version) echo "herdr 0.8.5" ;; *) echo "ran $0" ;; esac\n', { mode: 0o755 });
            const old = await source.herdrTree();
            expect(old.outdated).toBe(true);
            expect(old.missing).toBeUndefined();
            writeFileSync(binary, '#!/bin/sh\ncase "$1" in --version) echo "herdr 0.9.1" ;; *) echo "ran $0" ;; esac\n', { mode: 0o755 });
            const current = await source.herdrTree();
            expect(current.outdated).toBeUndefined();
            expect(current.missing).toBeUndefined();
            expect((await source.herdrCli(['status'])).stdout.trim()).toBe(`ran ${realpathSync(binary)}`);
        } finally {
            await source?.dispose();
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a running Herdr server older than muxr supports warns at host start and on Home, and clears once Herdr is updated', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-herdr-old-server-'));
        const binary = join(dir, 'herdr');
        // `herdr update` already replaced the binary; the server still running is the old one.
        writeFileSync(binary, '#!/bin/sh\ncase "$1" in --version) echo "herdr 0.9.1" ;; *) echo "ran $0" ;; esac\n', { mode: 0o755 });
        const saved = process.env.HERDR_BIN;
        process.env.HERDR_BIN = binary;
        const herdr = fakeHerdr(dir, dir);
        herdr.state.protocol = 21;
        const stderr = vi.spyOn(process.stderr, 'write');
        let source: Awaited<ReturnType<typeof createHerdrSessionSource>> | undefined;
        try {
            source = await createHerdrSessionSource({
                socketPath: herdr.socketPath, dataDir: join(dir, 'data'),
                artifactsDir: join(dir, 'attachments'), hostHttpPort: 0, herdrBin: binary,
            });
            const warning = 'Herdr is out of date: muxr needs Herdr 0.9.1 or newer. Run `herdr update`, then restart Herdr.\n';
            expect(stderr.mock.calls.map(([line]) => String(line))).toContain(warning);
            const old = await source.herdrTree();
            expect(old).toMatchObject({ connected: false, outdated: true });
            expect(old.missing).toBeUndefined();
            herdr.state.protocol = 22;
            await vi.waitFor(async () => expect(await source!.herdrTree()).toMatchObject({ connected: true }), { timeout: 10_000 });
            expect((await source.herdrTree()).outdated).toBeUndefined();
        } finally {
            stderr.mockRestore();
            await source?.dispose();
            herdr.close();
            if (saved === undefined) delete process.env.HERDR_BIN;
            else process.env.HERDR_BIN = saved;
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('isolated pi agent home', () => {
    it('forwards PI_CODING_AGENT_DIR into the pane env only when the host sets it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-pi-agent-dir-'));
        const previous = process.env.PI_CODING_AGENT_DIR;
        const launchEnv = async (value: string | undefined) => {
            if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = value;
            const runDir = mkdtempSync(join(dir, 'run-'));
            const herdr = fakeHerdr(runDir, join(runDir, 'repo'));
            const source = await createHerdrSessionSource({
                socketPath: herdr.socketPath,
                dataDir: join(runDir, 'data'),
                artifactsDir: join(runDir, 'attachments'),
                hostHttpPort: 0,
            });
            try {
                const started = await source.start({ cwd: join(runDir, 'repo'), kind: 'pi' });
                if (!('info' in started)) throw new Error('launch rejected');
                return (herdr.tabs[0] as { env?: Record<string, string> }).env;
            } finally {
                await source.dispose();
                herdr.close();
            }
        };
        try {
            // Diagnostics point this at a per-run temp dir so a real pi Herdr
            // spawns never touches the user's real ~/.pi/agent.
            expect(await launchEnv(join(dir, 'isolated-agent')))
                .toMatchObject({ PI_CODING_AGENT_DIR: join(dir, 'isolated-agent') });
            expect(await launchEnv(undefined)).not.toHaveProperty('PI_CODING_AGENT_DIR');
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('OpenCode account isolation', () => {
    it('starts an OpenCode Go account on the kit key delivery, with the Go model and attachment grant in config content, and --standalone on 2.x', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-oc-'));
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        mkdirSync(join(dir, 'repo'));
        writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.0.28"; fi\nexit 0\n');
        chmodSync(join(bin, 'opencode'), 0o755);
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: join(dir, 'home'),
            MUXR_HOME: join(dir, 'muxr'),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
        };
        // The pane config is read as the account's OpenCode would read it: from the host's own env.
        const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT };
        Object.assign(process.env, { HOME: env.HOME, PATH: env.PATH });
        delete process.env.XDG_CONFIG_HOME;
        delete process.env.OPENCODE_CONFIG;
        delete process.env.OPENCODE_CONFIG_CONTENT;
        // The kit lists the key's workspaces when it launches; the console refuses this one, so no workspace header.
        vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
        const a = await preparePlanSignIn(env, 'opencode');
        await planAccounts(env).saveKey(a.record.id, 'INERT_GO_KEY');
        const herdr = fakeHerdr(dir, join(dir, 'repo'));
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const tabEnvOf = (index: number) => (herdr.tabs[index] as { env?: Record<string, string> }).env ?? {};
        const attDir = `${join(dir, 'data', 'attachments')}/**`;
        try {
            // The sign-in tab only carries its prompt script: no OpenCode, HOME or XDG redirect.
            const tab = await source.start({ cwd: join(dir, 'repo'), ...a.launch });
            expect('info' in tab).toBe(true);
            expect(tabEnvOf(0).MUXR_PLAN_SIGNIN).toBeDefined();
            expect(tabEnvOf(0)).not.toHaveProperty('XDG_DATA_HOME');

            const launch = await planLaunchEnv(env, a.record);
            expect('info' in await source.start({ cwd: join(dir, 'repo'), kind: 'opencode', planEnv: launch.set, planUnset: launch.unset })).toBe(true);
            const agentEnv = tabEnvOf(1);
            // The key reaches OpenCode through the kit's files, never the pane env.
            expect(agentEnv.OPENCODE_CONFIG).toBe(join(a.record.folder, 'opencode.json'));
            expect(agentEnv.XDG_DATA_HOME).toBe(join(a.record.folder, 'data'));
            expect(readFileSync(join(a.record.folder, 'go.key'), 'utf8')).toBe('INERT_GO_KEY');
            expect(JSON.stringify(agentEnv)).not.toContain('INERT_GO_KEY');
            expect(JSON.parse(agentEnv.OPENCODE_CONFIG_CONTENT!)).toEqual({
                model: 'opencode-go/muse-spark-1.3-contributor',
                permission: { external_directory: { [attDir]: 'allow' } },
            });
            // 2.x gets its own background server per account.
            expect(herdr.agents.map((agent) => (agent as { args?: string[] }).args)).toEqual([['--standalone']]);

            // A model the user set stands; the grant still joins it.
            const userConfig = join(env.HOME!, '.config', 'opencode', 'opencode.json');
            mkdirSync(dirname(userConfig), { recursive: true });
            writeFileSync(userConfig, '{"model": "opencode-go/glm-flash-5.3"}');
            expect('info' in await source.start({ cwd: join(dir, 'repo'), kind: 'opencode', planEnv: launch.set, planUnset: launch.unset })).toBe(true);
            expect(JSON.parse(tabEnvOf(2).OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { external_directory: { [attDir]: 'allow' } } });
            // No launch passes `--model`: OpenCode 2.x has no such flag and exits on it.
            for (const agent of herdr.agents) expect(agent).not.toHaveProperty('model');
        } finally {
            vi.unstubAllGlobals();
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('pre-allows the attachment folder for an ambient OpenCode pane whatever path creates it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-oc-paths-'));
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        mkdirSync(join(dir, 'repo'));
        writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, 'opencode'), 0o755);
        // A bare launch resolves its binary from the host's own env; keep the
        // probe on the fake, and HOME on an empty dir so no real OpenCode
        // config leaks into the injected content.
        const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT };
        Object.assign(process.env, { HOME: join(dir, 'home'), PATH: `${bin}:${process.env.PATH ?? ''}` });
        delete process.env.XDG_CONFIG_HOME;
        delete process.env.OPENCODE_CONFIG;
        delete process.env.OPENCODE_CONFIG_CONTENT;
        const herdr = fakeHerdr(dir, join(dir, 'repo'));
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const started = await source.start({ cwd: join(dir, 'repo'), kind: 'opencode' });
            if (!('info' in started)) throw new Error('launch rejected');
            const split = await source.paneSplit({ sessionId: started.info.id, direction: 'right', kind: 'opencode' });
            const tab = await source.createTab(started.info.id, { kind: 'opencode' });
            const otherKind = await source.paneSplit({ sessionId: started.info.id, direction: 'down', kind: 'claude' });
            expect(split.sessionId).toBeDefined();
            expect(tab.sessionId).toBeDefined();
            expect(otherKind.sessionId).toBeDefined();
            const allow = (index: number) => {
                const env = (herdr.tabs[index] as { env?: Record<string, string> }).env ?? {};
                const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as
                    { permission?: { external_directory?: Record<string, string> } } | null;
                return content?.permission?.external_directory?.[`${join(dir, 'data', 'attachments')}/**`];
            };
            expect(allow(0)).toBe('allow'); // session.start
            expect(allow(1)).toBe('allow'); // pane.split (phone New pane / split sheet)
            expect(allow(2)).toBe('allow'); // tab.create
            expect(allow(3)).toBeUndefined(); // a claude pane carries no OpenCode config
        } finally {
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('starts a lone OpenCode account through session.start on its saved key, and refuses once it is signed out', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-oc-solo-'));
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        mkdirSync(join(dir, 'repo'));
        writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, 'opencode'), 0o755);
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: join(dir, 'home'),
            MUXR_HOME: join(dir, 'muxr'),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
        };
        const saved = { HOME: process.env.HOME, MUXR_HOME: process.env.MUXR_HOME, PATH: process.env.PATH };
        Object.assign(process.env, env);
        vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
        const herdr = fakeHerdr(dir, join(dir, 'repo'));
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const { dispatch } = createRequestDispatcher({ source, domain: {} as never, machineId: 'm1', hostVersion: '0.0.0' });
        try {
            const only = await preparePlanSignIn(env, 'opencode');
            const kit = planAccounts(env);
            await kit.saveKey(only.record.id, 'INERT_GO_KEY');
            const started = await dispatch({ type: 'session.start', requestId: 'solo', params: { cwd: join(dir, 'repo'), kind: 'opencode' } } as never);
            expect(started).toMatchObject({ ok: true });
            expect((await listPlans(env)).providers.find((entry) => entry.provider === 'opencode')?.accounts).toHaveLength(1);
            expect((herdr.tabs[0] as { env?: Record<string, string> }).env?.OPENCODE_CONFIG).toBe(join(only.record.folder, 'opencode.json'));
            await kit.logout(only.record.id);
            const refused = await dispatch({ type: 'session.start', requestId: 'signed-out', params: { cwd: join(dir, 'repo'), kind: 'opencode' } } as never);
            expect(refused).toMatchObject({ ok: false, code: 'plan-account-unavailable' });
            expect(herdr.tabs).toHaveLength(1);
            const omitted = await dispatch({ type: 'session.start', requestId: 'omitted-out', params: { cwd: join(dir, 'repo'), planAccount: only.record.id } } as never);
            expect(omitted).toMatchObject({ ok: false });
            await kit.saveKey(only.record.id, 'INERT_GO_KEY');
            const wrongKind = await dispatch({ type: 'session.start', requestId: 'omitted-in', params: { cwd: join(dir, 'repo'), planAccount: only.record.id } } as never);
            expect(wrongKind).toMatchObject({ ok: false, code: 'plan-kind-mismatch' });
            expect(herdr.tabs).toHaveLength(1);
        } finally {
            vi.unstubAllGlobals();
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('handoff: the agent writes its own note', () => {
    it('returns the note its agent wrote, refuses a busy agent before typing, and leaves no result file behind', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-handoff-'));
        const cwd = join(dir, 'repo');
        mkdirSync(cwd, { recursive: true });
        const herdr = fakeHerdr(dir, cwd);
        const note = 'Finish the launch test: the handoff case is the only one left.';
        herdr.state.handoffNote = note;
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        try {
            const started = await source.start({ cwd, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            Object.assign(herdr.agents[0]!, {
                agent: 'claude',
                agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'claude-1' },
            });
            herdr.emit('pane.agent_detected', { pane_id: 'w1:p1' });
            await source.refreshHerdr();

            await expect(source.handoff({ sessionId: started.info.id, targetName: 'Laptop' })).resolves.toEqual({ note });
            expect(herdr.state.prompts.filter((text) => text.includes('.byokit-turn-'))).toHaveLength(1);
            expect(readdirSync(cwd).filter((name) => name.startsWith('.byokit-turn-'))).toEqual([]);
            expect(herdr.agents[0]!.agent_status).toBe('idle');

            const firstTurn = source.handoff({ sessionId: started.info.id, targetName: 'Laptop' });
            await expect(source.handoff({ sessionId: started.info.id, targetName: 'Laptop' }))
                .rejects.toMatchObject({ code: 'handoff-busy' });
            await expect(firstTurn).resolves.toEqual({ note });
            expect(herdr.state.prompts.filter((text) => text.includes('.byokit-turn-'))).toHaveLength(2);

            herdr.agents[0]!.agent_status = 'working';
            const sent = herdr.state.prompts.length;
            await expect(source.handoff({ sessionId: started.info.id, targetName: 'Laptop' }))
                .rejects.toMatchObject({ code: 'handoff-busy' });
            expect(herdr.state.prompts).toHaveLength(sent);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

describe('source close lets the process exit', () => {
    it('clears watch guard timers and closes idempotently', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-close-'));
        const cwd = join(dir, 'repo');
        const herdr = fakeHerdr(dir, cwd);
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        // The hang: agentWatch arms one guard timer per session, up to an
        // hour out. Track that exact delay directly, plus the kit's own
        // in-flight agent.wait client timeout (timeout_ms + 5 s), which lands
        // on the same 65 s while the delayed reply is pending: launch
        // confirmation polls (200 ms sleeps, 60 s budgets) come and go, but
        // nothing else ever arms a 65 s timer. close() releases both.
        const guards = new Set<number>();
        const hook = createHook({
            init(asyncId, type, _trigger, resource) {
                if (type === 'Timeout'
                    && (resource as { _idleTimeout?: unknown })._idleTimeout === 65_000) {
                    guards.add(asyncId);
                }
            },
            destroy(asyncId) { guards.delete(asyncId); },
        });
        hook.enable();
        try {
            const started = await source.start({ cwd, kind: 'claude' });
            if (!('info' in started)) throw new Error('launch rejected');
            // Delay the wait reply past teardown: the watch is still in
            // flight when close() runs, so only close() itself can release
            // the guard and the assertions cannot race its settlement.
            herdr.state.delayAgentWaitMs = 300;
            await source.agentWatch({ sessionId: started.info.id, timeoutMs: 60_000 });
            expect(guards.size).toBe(2);
            await source.close();
            await source.close();
            await source.dispose();
            // async_hooks destroy delivery rides the loop, not the microtask
            // queue; the reply still cannot land inside this budget, so a
            // leaked guard stays to the deadline.
            await source.close();
            await source.close();
            await source.dispose();
            // async_hooks destroy delivery rides the loop, not the microtask
            // queue; the reply still cannot land inside this budget, so a
            // leaked guard stays to the deadline.
            const deadline = Date.now() + 200;
            while (guards.size !== 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(guards.size).toBe(0);
            // Launch confirmation is still sleeping when close runs. Shutdown
            // must not turn its cancellation into a failed launch and erase
            // the durable route after dispose has flushed it.
            await new Promise((resolve) => setTimeout(resolve, 300));
            const routes = JSON.parse(readFileSync(join(dir, 'data', 'herdr-routes.json'), 'utf8'));
            expect(routes.bindings).toEqual([expect.objectContaining({ route: started.info.id })]);
        } finally {
            hook.disable();
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('source close exits the process', () => {
    it('a script watching against fake Herdr exits on its own after close()', async () => {
        const root = fileURLToPath(new URL('../../../../../', import.meta.url));
        const script = join(root, 'scripts', 'diagnostics', 'application', 'checkHerdrSourceClose.mjs');
        // The script drives the compiled source: the suite typechecks (and so
        // rebuilds dist) before vitest runs, but a bare vitest invocation can
        // sit on a stale build -- fail loud instead of testing old code.
        const src = fileURLToPath(new URL('./herdrSessionSource.ts', import.meta.url));
        const dist = join(root, 'apps', 'host', 'dist', 'agent', 'infrastructure', 'herdrSessionSource.js');
        expect(statSync(dist).mtimeMs).toBeGreaterThanOrEqual(statSync(src).mtimeMs);
        const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        const exit = await Promise.race([
            new Promise<number | null>((resolve) => child.on('close', resolve)),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (exit === null) {
            child.kill('SIGKILL');
            throw new Error(`close script still alive after 20 s (a leftover handle wedges it): ${stderr.slice(-500)}`);
        }
        expect(stderr).toBe('');
        expect(stdout).toContain('herdr-source-close: ok');
        expect(exit).toBe(0);
    }, 30_000);
});
