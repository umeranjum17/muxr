/**
 * Fake Herdr control plane: NDJSON JSON-RPC on a unix socket, plus title/status
 * churn. Graphics and the HERDR_BIN shim are sibling modules.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startGraphics } from './graphics.mjs';
import { writeBinShim } from './bin.mjs';
import { agentRecord, createWorld, displayName, freezeWorld, relayoutTab } from './world.mjs';

const AGENT_STATUSES = ['idle', 'working', 'blocked', 'idle'];

export async function startFakeHerdr(options) {
    const dir = options?.dir;
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('fake-herdr: dir is required');
    const panes = options.panes ?? 8;
    const agents = options.agents ?? 4;
    const titleChurnHz = Number(options.titleChurnHz ?? 2);
    const terminalBytesPerSecond = options.terminalBytesPerSecond ?? 4096;
    const graphicsFrameHz = options.graphicsFrameHz ?? 0;
    const plugins = options.pluginsRoot === undefined ? [] : ['code', 'status', 'terminal-keys', 'attachments'].filter((name) => existsSync(join(options.pluginsRoot, name, 'muxr-ui.json'))).map((name) => {
        const root = resolve(options.pluginsRoot, name);
        const manifest = JSON.parse(readFileSync(join(root, 'muxr-ui.json'), 'utf8'));
        return { plugin_id: manifest.pluginId, name, version: '0.1.0', plugin_root: root, enabled: true, actions: [], source: { kind: 'local' } };
    });
    const cwd = join(dir, 'project');
    const attachJsonl = join(dir, 'attach.jsonl');
    const graphicsInputJsonl = join(dir, 'graphics-input.jsonl');
    const inputJsonl = join(dir, 'input.jsonl');


    mkdirSync(dir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    try { writeFileSync(join(cwd, 'README.md'), '# fake-herdr\n\nA deterministic herd.\n', { flag: 'wx' }); } catch { /* already seeded */ }
    try { writeFileSync(join(cwd, 'notes.txt'), 'line 1\nline 2\nline 3\n', { flag: 'wx' }); } catch { /* already seeded */ }
    const live = createWorld({ panes, agents, cwd, terminalBytesPerSecond });
    live.nextTab = live.tabs.length + 1;
    live.nextPane = live.panes.length + 1;
    live.nextWorkspace = 2;
    live.nextRevision = 1;
    live.nextLog = 1;
    live.zoomed = false;
    live.pluginLogs = [];
    const world = freezeWorld({
        workspaceId: live.workspaceId,
        cwd: live.cwd,
        terminalBytesPerSecond: live.terminalBytesPerSecond,
        workspaces: live.workspaces,
        tabs: live.tabs,
        panes: live.panes,
        agents: live.agents,
    });

    const socketPath = join(dir, 'herdr.sock');
    const clientSocketPath = join(dir, 'herdr-client.sock');
    unlinkQuiet(socketPath);

    const sockets = new Set();
    const eventSubs = new Set();
    const statusSubs = new Set();
    const timers = [];
    let closed = false;
    let graphics;
    let binPath;

    const server = createServer((socket) => {
        sockets.add(socket);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0) continue;
                handleLine(socket, line);
            }
        });
        socket.on('close', () => {
            sockets.delete(socket);
            for (const sub of eventSubs) if (sub.socket === socket) eventSubs.delete(sub);
            for (const sub of statusSubs) if (sub.socket === socket) statusSubs.delete(sub);
        });
        socket.on('error', () => {});
    });

    await listenUnix(server, socketPath);
    try {
        graphics = await startGraphics({
            socketPath: clientSocketPath,
            world,
            frameHz: graphicsFrameHz,
            enableFile: options.graphicsEnableFile,
            inputLogPath: graphicsInputJsonl,
        });
        binPath = writeBinShim({ dir, socketPath, terminalBytesPerSecond });
    } catch (error) {
        await shutdown();
        throw error;
    }

    if (titleChurnHz > 0) {
        let titleTick = 0;
        const titleTimer = setInterval(() => {
            titleTick += 1;
            for (const pane of live.panes) {
                const next = `${pane.label ?? 'pane'} · ${titleTick}`;
                pane.terminal_title = next;
                pane.terminal_title_stripped = next;
                const agent = live.agents.find((row) => row.pane_id === pane.pane_id);
                if (agent !== undefined) {
                    // Only the terminal title animates. An agent's task title is
                    // what it is working on and changes when the work does, so
                    // churning it here would fake a flood Herdr never sends and
                    // would bypass the host's title coalescing entirely.
                    agent.terminal_title = next;
                    agent.terminal_title_stripped = next;
                }
                emitEvent('pane.updated', {
                    pane_id: pane.pane_id,
                    pane: {
                        pane_id: pane.pane_id,
                        tab_id: pane.tab_id,
                        workspace_id: pane.workspace_id,
                        terminal_title: next,
                        terminal_title_stripped: next,
                        label: pane.label,
                        focused: pane.focused === true,
                    },
                });
            }
        }, 1000 / titleChurnHz);
        timers.push(titleTimer);

        // A new task now and then, which is what really moves an agent's title.
        const taskTimer = setInterval(() => {
            for (const [index, agent] of live.agents.entries()) {
                agent.title = `${agent.agent ?? 'agent'} task ${Math.floor(Date.now() / 30_000) + index}`;
            }
            for (const agent of live.agents) emitEvent('pane.updated', { pane_id: agent.pane_id });
        }, 30_000);
        timers.push(taskTimer);

        // Agents change state on human timescales, not per frame. Faking a
        // transition every few seconds would measure notification and attention
        // work no real herd produces.
        let statusTick = 0;
        const statusTimer = setInterval(() => {
            statusTick += 1;
            const status = AGENT_STATUSES[statusTick % AGENT_STATUSES.length];
            for (const agent of live.agents) {
                agent.agent_status = status;
                const pane = live.panes.find((row) => row.pane_id === agent.pane_id);
                if (pane !== undefined) pane.agent_status = status;
                emitStatus(agent.pane_id, status);
            }
        }, 15_000);
        timers.push(statusTimer);
    }

    function handleLine(socket, line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        const id = message.id;
        const method = message.method;
        const params = message.params ?? {};
        if (typeof method !== 'string') return;
        if (method === 'events.subscribe') {
            subscribe(socket, id, params);
            return;
        }
        const handler = methods[method];
        if (handler === undefined) {
            process.stderr.write(`fake-herdr: unhandled ${method}\n`);
            writeJson(socket, { id, error: { code: 'method_not_found', message: `unknown method ${method}` } });
            socket.end();
            return;
        }
        try {
            const result = handler(params);
            writeJson(socket, { id, result });
        } catch (error) {
            writeJson(socket, {
                id,
                error: { code: error.code ?? 'error', message: error.message ?? `${method} failed` },
            });
        }
        socket.end();
    }

    function subscribe(socket, id, params) {
        const subscriptions = Array.isArray(params.subscriptions) ? params.subscriptions : [];
        const statusKinds = subscriptions.filter((row) => row?.type === 'pane.agent_status_changed');
        if (statusKinds.length > 0 && statusKinds.length !== subscriptions.length) {
            writeJson(socket, {
                id,
                error: { code: 'invalid_subscription', message: 'pane.agent_status_changed cannot share a batch' },
            });
            socket.destroy();
            return;
        }
        writeJson(socket, { id, result: {} });
        if (statusKinds.length > 0) {
            for (const row of statusKinds) {
                if (typeof row.pane_id === 'string') statusSubs.add({ socket, paneId: row.pane_id });
            }
            return;
        }
        eventSubs.add({
            socket,
            kinds: new Set(subscriptions.map((row) => row?.type).filter((type) => typeof type === 'string')),
        });
    }

    function emitEvent(type, data) {
        const frame = `${JSON.stringify({ event: type, data: { type, ...data } })}\n`;
        for (const sub of eventSubs) {
            if (sub.kinds.size > 0 && !sub.kinds.has(type)) continue;
            try { sub.socket.write(frame); } catch { /* closed mid-churn */ }
        }
    }

    function emitStatus(paneId, agentStatus) {
        const frame = `${JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: paneId, agent_status: agentStatus } })}\n`;
        for (const sub of statusSubs) {
            if (sub.paneId !== paneId) continue;
            try { sub.socket.write(frame); } catch { /* closed mid-churn */ }
        }
    }

    const methods = {
        'session.snapshot': () => ({ snapshot: snapshotOf(live) }),
        'plugin.list': () => ({ plugins }),
        'plugin.action.invoke': (params) => {
            const logId = `log-${live.nextLog++}`;
            live.pluginLogs.unshift({
                log_id: logId,
                plugin_id: params.plugin_id,
                status: 'running',
                polls: 0,
            });
            return { log: { log_id: logId } };
        },
        'plugin.log.list': (params) => {
            const logs = live.pluginLogs.filter((log) => params.plugin_id === undefined || log.plugin_id === params.plugin_id);
            for (const log of logs) {
                log.polls += 1;
                if (log.status === 'running' && log.polls > 1) log.status = 'succeeded';
            }
            return {
                logs: logs.slice(0, params.limit ?? 50).map((log) => ({
                    log_id: log.log_id,
                    status: log.status,
                })),
            };
        },
        'server.agent_manifests': () => ({
            manifests: [{ agent: 'pi' }, { agent: 'claude' }, { agent: 'codex' }, { agent: 'gemini' }],
        }),
        'workspace.list': () => ({ workspaces: live.workspaces.map((workspace) => workspaceView(live, workspace)) }),
        'workspace.get': (params) => {
            const workspace = live.workspaces.find((row) => row.workspace_id === params.workspace_id);
            if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
            return { workspace: workspaceView(live, workspace) };
        },
        'workspace.create': (params) => {
            const workspace = addWorkspace(live, params.cwd ?? live.cwd, params.label ?? params.cwd);
            if (params.focus === true) focusWorkspace(live, workspace.workspace_id);
            return { workspace: workspaceView(live, workspace) };
        },
        'workspace.close': (params) => {
            removeWorkspace(live, params.workspace_id);
            return {};
        },
        'workspace.focus': (params) => {
            if (!live.workspaces.some((row) => row.workspace_id === params.workspace_id)) {
                throw fail('workspace_not_found', 'workspace not found');
            }
            focusWorkspace(live, params.workspace_id);
            return {};
        },
        'worktree.create': (params) => {
            const checkout = params.cwd ?? join(live.cwd, `wt-${live.nextWorkspace}`);
            const workspace = addWorkspace(live, checkout, checkout);
            workspace.worktree = {
                repo_key: 'fake-herdr',
                repo_name: 'fake-herdr',
                repo_root: live.cwd,
                checkout_path: checkout,
                is_linked_worktree: true,
            };
            return { workspace: { ...workspaceView(live, workspace), worktree: workspace.worktree } };
        },
        'tab.list': (params) => ({
            tabs: live.tabs.filter((tab) => tab.workspace_id === params.workspace_id),
        }),
        'tab.get': (params) => {
            const tab = live.tabs.find((row) => row.tab_id === params.tab_id);
            if (tab === undefined) throw fail('tab_not_found', 'tab not found');
            return { tab: tabView(live, tab) };
        },
        'tab.create': (params) => {
            const workspace = live.workspaces.find((row) => row.workspace_id === params.workspace_id);
            if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
            const tab = addTab(live, workspace.workspace_id, params.label ?? params.cwd);
            const pane = addPane(live, tab.tab_id, workspace.workspace_id, params.cwd ?? workspace.label ?? live.cwd);
            if (params.focus === true) focusPane(live, pane.pane_id);
            return { tab: tabView(live, tab), root_pane: { pane_id: pane.pane_id } };
        },
        'tab.close': (params) => {
            removeTab(live, params.tab_id);
            return {};
        },
        'tab.focus': (params) => {
            const tab = live.tabs.find((row) => row.tab_id === params.tab_id);
            if (tab === undefined) throw fail('tab_not_found', 'tab not found');
            const pane = live.panes.find((row) => row.tab_id === tab.tab_id);
            if (pane !== undefined) focusPane(live, pane.pane_id);
            return {};
        },
        'pane.get': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.pane_id);
            if (pane === undefined) throw fail('pane_not_found', 'pane not found');
            return { pane: paneView(pane) };
        },
        'pane.close': (params) => {
            removePane(live, params.pane_id);
            return {};
        },
        'pane.focus': (params) => {
            if (!live.panes.some((row) => row.pane_id === params.pane_id)) throw fail('pane_not_found', 'pane not found');
            focusPane(live, params.pane_id);
            return {};
        },
        'pane.focus_direction': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.pane_id);
            if (pane === undefined) throw fail('pane_not_found', 'pane not found');
            const neighbors = live.panes.filter((row) => row.tab_id === pane.tab_id);
            const index = neighbors.findIndex((row) => row.pane_id === pane.pane_id);
            const step = params.direction === 'left' || params.direction === 'up' ? -1 : 1;
            const next = neighbors[(index + step + neighbors.length) % neighbors.length];
            if (next !== undefined) focusPane(live, next.pane_id);
            return {};
        },
        'pane.send_keys': (params) => {
            appendFileSync(inputJsonl, `${JSON.stringify({
                at: new Date().toISOString(),
                method: 'pane.send_keys',
                pane_id: params.pane_id,
                keys: params.keys ?? [],
            })}\n`);
            return { pane_id: params.pane_id, keys: params.keys ?? [] };
        },
        'pane.report_metadata': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.pane_id);
            if (pane !== undefined && params.tokens !== undefined) {
                pane.tokens = { ...pane.tokens, ...params.tokens };
            }
            return {};
        },
        'pane.split': (params) => {
            const target = live.panes.find((row) => row.pane_id === params.target_pane_id);
            if (target === undefined) throw fail('pane_not_found', 'pane not found');
            const pane = addPane(live, target.tab_id, target.workspace_id, target.cwd);
            if (params.focus === true) focusPane(live, pane.pane_id);
            return { pane: { pane_id: pane.pane_id } };
        },
        'pane.read': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.pane_id);
            appendFileSync(attachJsonl, `${JSON.stringify({
                pane_id: params.pane_id,
                cols: Number(params.cols) || pane?.cols || 80,
                rows: Number(params.rows) || pane?.rows || 24,
                cellWidthPx: Number(params.cellWidthPx) || pane?.cellWidthPx || 0,
                cellHeightPx: Number(params.cellHeightPx) || pane?.cellHeightPx || 0,
                at: new Date().toISOString(),
            })}\n`);
            const body = pane === undefined
                ? ''
                : `${pane.terminal_title_stripped ?? pane.label ?? pane.pane_id}\nready.`;
            const lines = typeof params.lines === 'number' ? body.split('\n').slice(0, params.lines).join('\n') : body;
            return { read: { text: lines, truncated: false } };
        },
        'pane.layout': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.pane_id);
            if (pane === undefined) throw fail('pane_not_found', 'pane not found');
            return { layout: tabLayout(live, pane.tab_id) };
        },
        'pane.zoom': (params) => {
            if (!live.panes.some((row) => row.pane_id === params.pane_id)) throw fail('pane_not_found', 'pane not found');
            const mode = params.mode ?? 'toggle';
            const next = mode === 'on' ? true : mode === 'off' ? false : !live.zoomed;
            const changed = next !== live.zoomed;
            live.zoomed = next;
            return { zoom: { changed, zoomed: live.zoomed } };
        },
        'layout.export': (params) => {
            const panes = live.panes.filter((row) => row.tab_id === params.tab_id);
            if (panes.length === 0 && !live.tabs.some((tab) => tab.tab_id === params.tab_id)) {
                throw fail('tab_not_found', 'tab not found');
            }
            return { layout: { root: splitTree(panes) } };
        },
        'layout.apply': (params) => {
            const workspaceId = params.workspace_id ?? live.workspaces[0]?.workspace_id;
            const workspace = live.workspaces.find((row) => row.workspace_id === workspaceId);
            if (workspace === undefined) throw fail('workspace_not_found', 'workspace not found');
            const tab = addTab(live, workspace.workspace_id, params.tab_label);
            const root = materializeLayout(live, params.root, tab.tab_id, workspace.workspace_id, workspace.label ?? live.cwd);
            if (params.focus === true) {
                const first = live.panes.find((row) => row.tab_id === tab.tab_id);
                if (first !== undefined) focusPane(live, first.pane_id);
            }
            return { layout: { tab_id: tab.tab_id, root } };
        },
        'agent.start': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.pane_id);
            if (pane === undefined) throw fail('agent_pane_unavailable', 'pane not found');
            const kind = typeof params.kind === 'string' && params.kind.length > 0 ? params.kind : 'pi';
            const name = displayName(kind, params.name);
            const title = `${kind} · ${name}`;
            pane.agent_status = 'idle';
            pane.terminal_title = title;
            pane.terminal_title_stripped = title;
            pane.label = name;
            const agent = agentRecord({
                paneId: pane.pane_id,
                tabId: pane.tab_id,
                workspaceId: pane.workspace_id,
                cwd: pane.cwd ?? live.cwd,
                name,
                kind,
                value: typeof params.name === 'string' && params.name.length > 0 ? params.name : `gen-${pane.pane_id}`,
                title,
            });
            const index = live.agents.findIndex((row) => row.pane_id === pane.pane_id);
            if (index === -1) live.agents.push(agent);
            else live.agents[index] = agent;
            return { agent };
        },
        'agent.wait': (params) => {
            const paneId = params.target;
            const agent = live.agents.find((row) => row.pane_id === paneId);
            if (agent !== undefined) return { agent };
            const pane = live.panes.find((row) => row.pane_id === paneId);
            return {
                agent: {
                    pane_id: paneId,
                    agent_status: pane?.agent_status ?? 'idle',
                    interactive_ready: true,
                },
            };
        },
        'agent.prompt': (params) => {
            const pane = live.panes.find((row) => row.pane_id === params.target);
            if (pane === undefined) throw fail('pane_not_found', 'pane not found');
            const agent = live.agents.find((row) => row.pane_id === pane.pane_id);
            if (agent !== undefined) agent.agent_status = 'working';
            pane.agent_status = 'working';
            return {
                type: 'agent_prompted',
                agent: {
                    terminal_id: `term-${pane.pane_id}`,
                    agent_status: 'working',
                    workspace_id: pane.workspace_id,
                    tab_id: pane.tab_id,
                    pane_id: pane.pane_id,
                    focused: pane.focused === true,
                    revision: live.nextRevision++,
                },
            };
        },
        'agent.send_keys': (params) => {
            appendFileSync(inputJsonl, `${JSON.stringify({
                at: new Date().toISOString(),
                method: 'agent.send_keys',
                target: params.target,
                keys: params.keys ?? [],
            })}\n`);
            return { target: params.target, keys: params.keys ?? [] };
        },
    };

    async function shutdown() {
        for (const timer of timers) clearInterval(timer);
        timers.length = 0;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        eventSubs.clear();
        statusSubs.clear();
        await new Promise((resolve) => server.close(resolve));
        unlinkQuiet(socketPath);
        try { graphics?.close(); } catch { /* already torn down */ }
        unlinkQuiet(clientSocketPath);
    }

    async function close() {
        if (closed) return;
        closed = true;
        await shutdown();
    }

    return { socketPath, clientSocketPath, binPath, world, close, attachJsonl, graphicsInputJsonl, inputJsonl };
}

function snapshotOf(live) {
    return {
        workspaces: live.workspaces.map((workspace) => workspaceView(live, workspace)),
        tabs: live.tabs.map((tab) => ({ tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label })),
        panes: live.panes.map(paneView),
        agents: live.agents.map((agent) => ({ ...agent })),
    };
}

function workspaceView(live, workspace) {
    const tabs = live.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
    const focusedPane = live.panes.find((pane) => pane.workspace_id === workspace.workspace_id && pane.focused);
    return {
        workspace_id: workspace.workspace_id,
        label: workspace.label,
        focused: workspace.focused === true,
        tab_count: tabs.length,
        active_tab_id: focusedPane?.tab_id ?? tabs[0]?.tab_id,
        ...(workspace.worktree === undefined ? {} : { worktree: workspace.worktree }),
    };
}

function tabView(live, tab) {
    return {
        tab_id: tab.tab_id,
        workspace_id: tab.workspace_id,
        label: tab.label,
        pane_count: live.panes.filter((pane) => pane.tab_id === tab.tab_id).length,
    };
}

function paneView(pane) {
    return {
        pane_id: pane.pane_id,
        tab_id: pane.tab_id,
        workspace_id: pane.workspace_id,
        cwd: pane.cwd,
        foreground_cwd: pane.foreground_cwd,
        ...(pane.agent_status === undefined ? {} : { agent_status: pane.agent_status }),
        terminal_title: pane.terminal_title,
        terminal_title_stripped: pane.terminal_title_stripped,
        label: pane.label,
        focused: pane.focused === true,
        ...(pane.tokens === undefined ? {} : { tokens: pane.tokens }),
    };
}

function tabLayout(live, tabId) {
    const panes = live.panes.filter((pane) => pane.tab_id === tabId);
    let width = 80;
    let height = 24;
    for (const pane of panes) {
        width = Math.max(width, pane.rect.x + pane.rect.width);
        height = Math.max(height, pane.rect.y + pane.rect.height);
    }
    const focused = panes.find((pane) => pane.focused === true) ?? panes[0];
    return {
        workspace_id: focused?.workspace_id,
        tab_id: tabId,
        focused_pane_id: focused?.pane_id,
        zoomed: live.zoomed === true,
        area: { x: 0, y: 0, width, height },
        panes: panes.map((pane) => ({
            pane_id: pane.pane_id,
            focused: pane.focused === true,
            rect: pane.rect,
        })),
    };
}

function splitTree(panes) {
    if (panes.length === 0) return { type: 'pane' };
    if (panes.length === 1) return { type: 'pane', pane_id: panes[0].pane_id, cwd: panes[0].cwd };
    const mid = Math.ceil(panes.length / 2);
    return {
        type: 'split',
        direction: 'down',
        ratio: mid / panes.length,
        first: splitTree(panes.slice(0, mid)),
        second: splitTree(panes.slice(mid)),
    };
}

function materializeLayout(live, node, tabId, workspaceId, cwd) {
    if (node === undefined || node === null || typeof node !== 'object') {
        const pane = addPane(live, tabId, workspaceId, cwd);
        return { type: 'pane', pane_id: pane.pane_id, cwd: pane.cwd };
    }
    if (node.type === 'split') {
        return {
            type: 'split',
            direction: node.direction ?? 'down',
            ratio: node.ratio ?? 0.5,
            first: materializeLayout(live, node.first, tabId, workspaceId, cwd),
            second: materializeLayout(live, node.second, tabId, workspaceId, cwd),
        };
    }
    const pane = addPane(live, tabId, workspaceId, node.cwd ?? cwd);
    return { type: 'pane', pane_id: pane.pane_id, cwd: pane.cwd };
}

function addWorkspace(live, cwd, label) {
    const workspaceId = `w${live.nextWorkspace++}`;
    const workspace = {
        workspace_id: workspaceId,
        label: label ?? cwd,
        focused: false,
        worktree: {
            repo_key: 'fake-herdr',
            repo_name: 'fake-herdr',
            repo_root: cwd,
            checkout_path: cwd,
            is_linked_worktree: false,
        },
    };
    live.workspaces.push(workspace);
    return workspace;
}

function addTab(live, workspaceId, label) {
    const existing = live.tabs.filter((tab) => tab.workspace_id === workspaceId).length;
    const tab = {
        tab_id: workspaceId === 'w1' ? `w1:t${live.nextTab++}` : `${workspaceId}:t${existing + 1}`,
        workspace_id: workspaceId,
        label,
    };
    live.tabs.push(tab);
    return tab;
}

function addPane(live, tabId, workspaceId, cwd) {
    const paneNum = workspaceId === 'w1'
        ? live.nextPane++
        : live.panes.filter((row) => row.workspace_id === workspaceId).length + 1;
    const pane = {
        pane_id: `${workspaceId}:p${paneNum}`,
        tab_id: tabId,
        workspace_id: workspaceId,
        cwd,
        foreground_cwd: cwd,
        terminal_title: `zsh · ${cwd}`,
        terminal_title_stripped: `zsh · ${cwd}`,
        label: 'zsh',
        focused: false,
        tokens: {},
        rect: { x: 0, y: 0, width: 80, height: 24 },
    };
    live.panes.push(pane);
    relayoutTab(live, tabId);
    return pane;
}

function removeWorkspace(live, workspaceId) {
    const tabs = live.tabs.filter((tab) => tab.workspace_id === workspaceId).map((tab) => tab.tab_id);
    for (const tabId of tabs) removeTab(live, tabId);
    live.workspaces = live.workspaces.filter((row) => row.workspace_id !== workspaceId);
}

function removeTab(live, tabId) {
    const panes = live.panes.filter((pane) => pane.tab_id === tabId).map((pane) => pane.pane_id);
    for (const paneId of panes) removePane(live, paneId);
    live.tabs = live.tabs.filter((tab) => tab.tab_id !== tabId);
}

function removePane(live, paneId) {
    const pane = live.panes.find((row) => row.pane_id === paneId);
    live.panes = live.panes.filter((row) => row.pane_id !== paneId);
    live.agents = live.agents.filter((row) => row.pane_id !== paneId);
    if (pane !== undefined) relayoutTab(live, pane.tab_id);
}

function focusWorkspace(live, workspaceId) {
    for (const workspace of live.workspaces) workspace.focused = workspace.workspace_id === workspaceId;
    const pane = live.panes.find((row) => row.workspace_id === workspaceId);
    if (pane !== undefined) focusPane(live, pane.pane_id);
}

function focusPane(live, paneId) {
    const pane = live.panes.find((row) => row.pane_id === paneId);
    if (pane === undefined) return;
    for (const row of live.panes) row.focused = row.pane_id === paneId;
    for (const workspace of live.workspaces) workspace.focused = workspace.workspace_id === pane.workspace_id;
}

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

function writeJson(socket, value) {
    socket.write(`${JSON.stringify(value)}\n`);
}

function unlinkQuiet(path) {
    try { unlinkSync(path); } catch { /* absent */ }
}

function listenUnix(server, socketPath) {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(socketPath, () => {
            server.off('error', onError);
            resolve();
        });
    });
}

function parseArgs(argv) {
    const out = {
        dir: undefined,
        panes: 8,
        agents: 4,
        titleChurnHz: 2,
        terminalBytesPerSecond: 4096,
        graphicsFrameHz: 0,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (flag === '--dir') { out.dir = value; index += 1; }
        else if (flag === '--panes') { out.panes = Number(value); index += 1; }
        else if (flag === '--agents') { out.agents = Number(value); index += 1; }
        else if (flag === '--title-churn-hz') { out.titleChurnHz = Number(value); index += 1; }
        else if (flag === '--terminal-bytes-per-second') { out.terminalBytesPerSecond = Number(value); index += 1; }
        else if (flag === '--graphics-frame-hz') { out.graphicsFrameHz = Number(value); index += 1; }
        else if (flag === '--graphics-enable-file') { out.graphicsEnableFile = value; index += 1; }
        else if (flag === '--plugins-root') { out.pluginsRoot = value; index += 1; }
    }
    if (out.dir === undefined) throw new Error('fake-herdr: --dir is required');
    return out;
}

const isMain = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    const handle = await startFakeHerdr(parseArgs(process.argv.slice(2)));
    // One line, so a harness can read the sockets and the world it must expect.
    process.stdout.write(`${JSON.stringify({
        socketPath: handle.socketPath,
        clientSocketPath: handle.clientSocketPath,
        binPath: handle.binPath,
        world: handle.world,
        attachJsonl: handle.attachJsonl,
        graphicsInputJsonl: handle.graphicsInputJsonl,
        inputJsonl: handle.inputJsonl,
    })}\n`);
    const stop = async () => {
        await handle.close();
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
