import { createHook } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { HostFrame, HerdrTreeWorkspace } from '@trymuxr/contract';
import { WebSocket } from 'ws';
import { DeviceLink, hostId, type DeviceGrant } from '@byokit/link';
import { generateKeyPair } from '@trymuxr/crypto';
import { startRelay } from '@muxr/relay';
import { preparePlanSignIn } from '../../plans/planSignIn.js';
import { listPlans, planLaunchEnv } from '../../plans/plansApi.js';
import { createRequestDispatcher } from '../../requests/index.js';
import { createAgentWatchStores } from '../application/watchStores.js';
import { startHost } from '../../host.js';
import { LinkEndpoint, type MachineCryptoState } from '../../machine/index.js';
import { createHerdrSessionSource, boundedWorkspaceTokens } from './herdrSessionSource.js';

/**
 * The slice of herdr a phone launch touches. `agent.start` answers the way
 * herdr 0.8 does: the record carries the launch name but no kind or session
 * until the process is detected, which is the boot window under test.
 */
function fakeHerdr(dir: string, cwd: string) {
    const workspaces = [{ workspace_id: 'w1', label: cwd }];
    const tabs: Record<string, unknown>[] = [];
    const panes: Record<string, unknown>[] = [];
    const agents: Record<string, unknown>[] = [];
    /** Like herdr, a pushed event reaches only the sockets subscribed to it; status is per pane. */
    const subscribers = new Map<Socket, Array<{ type: string; pane_id?: string }>>();
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
    } = { failSnapshot: false, failSnapshotAfterPrompt: false, snapshotCount: 0, holdNextSnapshot: false, holdStatusAck: false, delayAgentWaitMs: 0, paneText: '', sentTexts: [] };
    const pendingReplies = new Set<NodeJS.Timeout>();
    const heldStatusAcks: Array<() => void> = [];
    let next = 1;
    const handleSnapshot = () => ({ snapshot: { workspaces, tabs, panes, agents } });
    const handlePluginList = () => ({ plugins: [] });
    const handleWorkspaceList = () => ({ workspaces });
    const handleTabCreate = (params: Record<string, unknown>) => {
        const tab_id = `t${next}`;
        const pane_id = `w1:p${next++}`;
        tabs.push({ tab_id, workspace_id: 'w1', label: params.label ?? cwd, env: params.env });
        panes.push({ pane_id, tab_id, workspace_id: 'w1', cwd, env: params.env });
        return { tab: { tab_id }, root_pane: { pane_id } };
    };
    const handleAgentStart = (params: Record<string, unknown>) => {
        const agent = { pane_id: params.pane_id, name: params.name, agent_status: 'idle' };
        agents.push(agent);
        return { agent };
    };
    const handleAgentWait = (params: Record<string, unknown>) => ({
        agent: agents.find((agent) => agent.pane_id === params.target),
    });
    const handleAgentPrompt = (params: Record<string, unknown>) => {
        if (state.failSnapshotAfterPrompt) state.failSnapshot = true;
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
    const handlePaneClose = () => ({});
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
                let reply: unknown;
                switch (method) {
                    case 'ping':
                        reply = { id, result: { protocol: 22 } };
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
                    case 'agent.prompt':
                        reply = { id, result: handleAgentPrompt(p) };
                        break;
                    case 'pane.read':
                        reply = { id, result: { read: { text: state.paneText } } };
                        break;
                    case 'pane.send_text':
                        reply = { id, result: handlePaneSendText(p) };
                        break;
                    case 'pane.close':
                        reply = { id, result: handlePaneClose() };
                        break;
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
        agents,
        tabs,
        panes,
        emit(type: string, data: Record<string, unknown>): void {
            for (const [socket, subscriptions] of subscribers) {
                if (wants(subscriptions, type, data.pane_id)) socket.write(`${JSON.stringify({ event: type, data })}\n`);
            }
        },
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
        host.onBroadcast((frame) => endpoint!.broadcast(frame));
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
            await source.dispose(); await relay.close(); herdr.close();
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
            Object.assign(herdr.agents[0]!, {
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
    it('gives one account the same private root for its sign-in tab and its agents, keeps two accounts apart, and carries blocked variables out', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-oc-'));
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, 'opencode'), 0o755);
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: join(dir, 'home'),
            MUXR_HOME: join(dir, 'muxr'),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
        };
        // Two accounts, each with its own private root muxr created.
        const a = await preparePlanSignIn(env, 'opencode');
        const b = await preparePlanSignIn(env, 'opencode');
        expect(a.record.folder).not.toBe(b.record.folder);
        const herdr = fakeHerdr(dir, join(dir, 'repo'));
        const source = await createHerdrSessionSource({
            socketPath: herdr.socketPath,
            dataDir: join(dir, 'data'),
            artifactsDir: join(dir, 'attachments'),
            hostHttpPort: 0,
        });
        const blocked = ['OPENCODE_AUTH', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_TEST_HOME', 'OPENCODE_DB'];
        const tabEnvOf = (index: number) => (herdr.tabs[index] as { env?: Record<string, string> }).env ?? {};
        try {
            // The sign-in tab and every agent start for account A land in A's root.
            const tab = await source.start({ cwd: join(dir, 'repo'), ...a.launch });
            expect('info' in tab).toBe(true);
            const launchA = planLaunchEnv(env, a.record);
            const agentA = await source.start({ cwd: join(dir, 'repo'), kind: 'opencode', planEnv: launchA.set, planUnset: launchA.unset });
            expect('info' in agentA).toBe(true);
            for (const tabEnv of [tabEnvOf(0), tabEnvOf(1)]) {
                expect(tabEnv.HOME).toBe(a.record.folder);
                expect(tabEnv.XDG_CONFIG_HOME).toBe(join(a.record.folder, '.config'));
                expect(tabEnv.XDG_DATA_HOME).toBe(join(a.record.folder, '.local', 'share'));
                expect(tabEnv.XDG_STATE_HOME).toBe(join(a.record.folder, '.local', 'state'));
                expect(tabEnv.XDG_CACHE_HOME).toBe(join(a.record.folder, '.cache'));
                expect(tabEnv.TMPDIR).toBe(join(a.record.folder, '.tmp'));
            }
            expect(tabEnvOf(0).MUXR_PLAN_SIGNIN).toBeDefined();
            // A second account gets a different root for its own agent start.
            const launchB = planLaunchEnv(env, b.record);
            const agentB = await source.start({ cwd: join(dir, 'repo'), kind: 'opencode', planEnv: launchB.set, planUnset: launchB.unset });
            expect('info' in agentB).toBe(true);
            expect(tabEnvOf(2).HOME).toBe(b.record.folder);
            expect(tabEnvOf(2).HOME).not.toBe(a.record.folder);
            // No blocked OpenCode variable reaches any pane, and the launch carried them out.
            for (const index of [0, 1, 2]) {
                for (const name of blocked) expect(tabEnvOf(index)).not.toHaveProperty(name);
            }
            const unsets = herdr.state.sentTexts.filter((text) => text.startsWith('unset '));
            for (const name of blocked) expect(unsets.some((text) => text.includes(name))).toBe(true);
        } finally {
            await source.dispose();
            herdr.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('starts a lone OpenCode account through session.start in its own root, and refuses once it is signed out', async () => {
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
            const authFile = join(only.record.folder, '.local', 'share', 'opencode', 'auth.json');
            mkdirSync(dirname(authFile), { recursive: true });
            writeFileSync(authFile, '{"openai":{}}');
            const started = await dispatch({ type: 'session.start', requestId: 'solo', params: { cwd: join(dir, 'repo'), kind: 'opencode' } } as never);
            expect(started).toMatchObject({ ok: true });
            expect((await listPlans(env)).providers.find((entry) => entry.provider === 'opencode')?.accounts).toHaveLength(1);
            expect((herdr.tabs[0] as { env?: Record<string, string> }).env?.HOME).toBe(only.record.folder);
            rmSync(authFile);
            const refused = await dispatch({ type: 'session.start', requestId: 'signed-out', params: { cwd: join(dir, 'repo'), kind: 'opencode' } } as never);
            expect(refused).toMatchObject({ ok: false, code: 'plan-account-unavailable' });
            expect(herdr.tabs).toHaveLength(1);
            const omitted = await dispatch({ type: 'session.start', requestId: 'omitted-out', params: { cwd: join(dir, 'repo'), planAccount: only.record.id } } as never);
            expect(omitted).toMatchObject({ ok: false });
            writeFileSync(authFile, '{"openai":{}}');
            const wrongKind = await dispatch({ type: 'session.start', requestId: 'omitted-in', params: { cwd: join(dir, 'repo'), planAccount: only.record.id } } as never);
            expect(wrongKind).toMatchObject({ ok: false, code: 'plan-kind-mismatch' });
            expect(herdr.tabs).toHaveLength(1);
        } finally {
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
