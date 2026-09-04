#!/usr/bin/env node
/**
 * HERDR_BIN shim. The host never talks JSON-RPC through this process; it
 * execs argv and reads stdout. World lives on the control socket.
 */
import { chmodSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WORLD, requestFrames, tileRects } from './graphics.mjs';

const SELF = fileURLToPath(import.meta.url);

function flag(args, name) {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];
    const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
    return prefixed?.slice(name.length + 1);
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function rpc(method, params = {}) {
    const socketPath = process.env.FAKE_HERDR_SOCKET;
    if (!socketPath) return Promise.resolve(null);
    return new Promise((resolveRpc) => {
        const socket = createConnection(socketPath);
        const id = `fake_bin_${process.pid}_${Math.random().toString(16).slice(2)}`;
        let buffer = '';
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.removeAllListeners();
            socket.destroy();
            resolveRpc(value);
        };
        const timer = setTimeout(() => finish(null), 2000);
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() === '') continue;
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message.id !== id) continue;
                finish(message.error != null ? null : (message.result ?? {}));
                return;
            }
        });
        socket.on('error', () => finish(null));
        socket.on('end', () => {
            if (buffer.trim() === '') {
                finish(null);
                return;
            }
            try {
                const message = JSON.parse(buffer);
                finish(message.id === id && message.error == null ? (message.result ?? {}) : null);
            } catch {
                finish(null);
            }
        });
    });
}

async function loadWorld() {
    const result = await rpc('session.snapshot');
    const snapshot = result?.snapshot ?? result;
    if (snapshot?.panes?.length || snapshot?.workspaces?.length) return snapshot;
    return DEFAULT_WORLD;
}

function workspacesOf(world) {
    const tabs = world.tabs ?? [];
    return (world.workspaces ?? []).map((workspace) => ({
        workspace_id: workspace.workspace_id,
        label: workspace.label,
        focused: workspace.focused === true,
        tab_count: workspace.tab_count ?? tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).length,
        active_tab_id: workspace.active_tab_id
            ?? tabs.find((tab) => tab.workspace_id === workspace.workspace_id)?.tab_id,
    }));
}

function panesOf(world) {
    return (world.panes ?? []).map((pane, index) => ({
        pane_id: pane.pane_id,
        tab_id: pane.tab_id,
        workspace_id: pane.workspace_id,
        focused: pane.focused === true,
        cwd: pane.cwd,
        rect: pane.rect ?? tileRects(world.panes.length)[index],
    }));
}

function synthesizeLayout(world, paneId) {
    const panes = panesOf(world);
    const selected = panes.find((pane) => pane.pane_id === paneId)
        ?? panes.find((pane) => pane.focused)
        ?? panes[0];
    if (selected === undefined) {
        return {
            workspace_id: 'w1',
            tab_id: 't1',
            focused_pane_id: 'p1',
            zoomed: false,
            area: { x: 0, y: 0, width: 80, height: 24 },
            panes: [{ pane_id: 'p1', focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } }],
        };
    }
    const siblings = panes.filter((pane) => pane.tab_id === selected.tab_id);
    const tiles = siblings.map((pane, index) => pane.rect ?? tileRects(siblings.length)[index]);
    const right = Math.max(80, ...tiles.map((rect) => rect.x + rect.width));
    const bottom = Math.max(24, ...tiles.map((rect) => rect.y + rect.height));
    return {
        workspace_id: selected.workspace_id,
        tab_id: selected.tab_id,
        focused_pane_id: siblings.find((pane) => pane.focused)?.pane_id ?? selected.pane_id,
        zoomed: false,
        area: { x: 0, y: 0, width: right, height: bottom },
        panes: siblings.map((pane, index) => ({
            pane_id: pane.pane_id,
            focused: pane.focused,
            rect: tiles[index],
        })),
    };
}

async function paneList() {
    const world = await loadWorld();
    return { panes: panesOf(world) };
}

async function paneLayout(paneId) {
    const world = await loadWorld();
    const fallback = synthesizeLayout(world, paneId);
    const fromRpc = await rpc('pane.layout', { pane_id: paneId });
    const layout = fromRpc?.layout;
    if (layout === undefined) return { layout: fallback };
    // Host routing compares workspace_id/tab_id to workspace.list; control pane.layout omits them.
    return {
        layout: {
            ...fallback,
            ...layout,
            workspace_id: layout.workspace_id ?? fallback.workspace_id,
            tab_id: layout.tab_id ?? fallback.tab_id,
            focused_pane_id: layout.focused_pane_id
                ?? layout.panes?.find((pane) => pane.focused)?.pane_id
                ?? fallback.focused_pane_id,
        },
    };
}

async function workspaceList() {
    const fromRpc = await rpc('workspace.list');
    if (fromRpc?.workspaces) return { workspaces: fromRpc.workspaces };
    return { workspaces: workspacesOf(await loadWorld()) };
}

async function processInfo(paneId) {
    const world = await loadWorld();
    const panes = panesOf(world);
    const index = Math.max(0, panes.findIndex((pane) => pane.pane_id === paneId));
    return { process_info: { foreground_process_group_id: 1000 + index } };
}

function writeResult(value) {
    process.stdout.write(`${JSON.stringify({ result: value })}\n`);
}

function shellChunk(seq, size) {
    const line = `\u001b[32m$\u001b[0m echo frame-${seq}\nframe-${seq}\n`;
    let text = '';
    while (text.length < size) text += line;
    return text.slice(0, size);
}

function inputBytes(message) {
    if (typeof message.bytes !== 'string' || message.bytes.length === 0) return '';
    try {
        return Buffer.from(message.bytes, 'base64').toString('latin1');
    } catch {
        return '';
    }
}

const WHEEL_REPORT = /\x1b\[<(64|65);(\d+);(\d+)M/g;

function wheelReports(text) {
    WHEEL_REPORT.lastIndex = 0;
    const matches = String(text).match(WHEEL_REPORT);
    return matches === null ? 0 : matches.length;
}

function runTerminal(args) {
    const paneId = args[1] ?? 'p1';
    let cols = Number(flag(args, '--cols') ?? 80) || 80;
    let rows = Number(flag(args, '--rows') ?? 24) || 24;
    const bps = Math.max(0, Number(process.env.FAKE_HERDR_TERMINAL_BPS ?? 4096) || 0);
    let seq = 0;
    const writeFrame = (record) => {
        process.stdout.write(`${JSON.stringify(record)}\n`);
    };
    const tickMs = 100;
    const perTick = Math.max(1, Math.round(bps * tickMs / 1000));
    // Herdr's real cost model: a scroll or a resize costs the whole screen, and
    // the stream repaints itself periodically. The phone's scroll acking and
    // write pump were built against that, so a fake that only ever appends
    // measures the easy half of the work.
    const emit = (full) => {
        seq += 1;
        const size = full ? cols * rows : perTick;
        writeFrame({
            type: 'terminal.frame',
            seq,
            encoding: 'ansi',
            width: cols,
            height: rows,
            full,
            bytes: Buffer.from(shellChunk(seq, size)).toString('base64'),
        });
    };
    writeFrame({ type: 'terminal.ready', pane_id: paneId, cols, rows });
    const repaintEveryTicks = 50;
    let ticks = 0;
    const timer = bps > 0
        ? setInterval(() => {
            ticks += 1;
            emit(ticks === 1 || ticks % repaintEveryTicks === 0);
        }, tickMs)
        : undefined;

    let buffer = '';
    const finish = () => {
        if (timer !== undefined) clearInterval(timer);
        process.stdin.removeAllListeners();
        process.exit(0);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        let burst = 0;
        for (const line of lines) {
            if (line.trim() === '') continue;
            try {
                const message = JSON.parse(line);
                if (message.type === 'terminal.release') finish();
                else if (message.type === 'terminal.resize') {
                    cols = Number(message.cols) || cols;
                    rows = Number(message.rows) || rows;
                    emit(true);
                } else if (message.type === 'terminal.scroll') emit(true);
                else if (message.type === 'terminal.input') {
                    burst += wheelReports(inputBytes(message));
                }
            } catch {
                /* phone JSON is forwarded as-is; ignore non-JSON */
            }
        }
        // The pane the phone is actually watching is the one whose repaints
        // matter; a round robin across a hundred panes measures nothing.
        if (burst > 0) requestFrames(burst, paneId);
    });
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.stdin.resume();
}

export function writeBinShim({ dir, socketPath }) {
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, 'herdr');
    writeFileSync(
        binPath,
        `#!/bin/sh\nexport FAKE_HERDR_SOCKET=${shellQuote(socketPath)}\nexec ${shellQuote(process.execPath)} ${shellQuote(SELF)} "$@"\n`,
        { encoding: 'utf8' },
    );
    chmodSync(binPath, 0o755);
    chmodSync(SELF, 0o755);
    return binPath;
}

export async function main(argv = process.argv.slice(2)) {
    const [cmd, sub, ...rest] = argv;
    if (cmd === 'terminal' && sub === 'session') {
        runTerminal(rest);
        return;
    }
    if (cmd === 'pane' && sub === 'list') {
        writeResult(await paneList());
        return;
    }
    if (cmd === 'pane' && sub === 'layout') {
        writeResult(await paneLayout(flag(rest, '--pane')));
        return;
    }
    if (cmd === 'pane' && sub === 'process-info') {
        writeResult(await processInfo(flag(rest, '--pane')));
        return;
    }
    if (cmd === 'workspace' && sub === 'list') {
        writeResult(await workspaceList());
        return;
    }
    process.stderr.write(`fake-herdr bin: unhandled ${argv.join(' ')}\n`);
    process.stdout.write('{}\n');
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === SELF;
if (invoked) {
    // The host drives this binary for terminals, layout and process probes, so
    // a stalled invocation stalls the host. FAKE_HERDR_LOG makes that visible.
    const started = Date.now();
    const trace = process.env.FAKE_HERDR_LOG;
    if (trace !== undefined) {
        const record = (note) => {
            try { appendFileSync(trace, `${new Date().toISOString()} ${Date.now() - started}ms ${note} ${process.argv.slice(2).join(' ')}\n`); }
            catch { /* the harness removed its scratch dir */ }
        };
        record('start');
        process.on('exit', () => record('exit'));
    }
    await main(process.argv.slice(2));
}
