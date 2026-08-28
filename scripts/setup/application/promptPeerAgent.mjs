import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const HELP = `muxr peers list [--machine <name>]
muxr peers read --machine <name> [--agent <name>] [--lines <n>]
muxr peers status --machine <name> [--agent <name>]
muxr peers watch --machine <name> [--agent <name>] [--timeout-ms <n>]
muxr peers prompt --machine <name> [--agent <name>] --text <prompt>

Uses Machine Names and Agent Names. Output is JSON. Peer grants never include raw shell, terminal takeover, or destructive actions.
`;

function accessFile() {
    if (process.env.MUXR_PEER_ACCESS_FILE?.trim()) return process.env.MUXR_PEER_ACCESS_FILE.trim();
    const home = process.env.MUXR_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr');
    return join(home, 'host', 'peer', 'cli.json');
}

function readAccess() {
    const path = accessFile();
    let info;
    try { info = lstatSync(path); } catch {
        throw new Error('Peer access is not ready. Run `muxr daemon restart`, then enable Computer collaboration in the app.');
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Peer access file is unsafe; run `muxr daemon restart` to replace it.');
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Peer access file is invalid; run `muxr daemon restart` to replace it.'); }
    if (value?.version !== 1 || typeof value.socketPath !== 'string' || !isAbsolute(value.socketPath)
        || typeof value.capability !== 'string' || !/^[A-Za-z0-9_-]{40,80}$/.test(value.capability)) {
        throw new Error('Peer access file is invalid; run `muxr daemon restart` to replace it.');
    }
    return { socketPath: value.socketPath, capability: value.capability };
}

function options(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (flag === '--json') continue;
        if (!['--machine', '--agent', '--lines', '--timeout-ms', '--text'].includes(flag)) throw new Error(`Unknown peers option: ${flag}`);
        const value = args[++index];
        if (value === undefined || value === '') throw new Error(`${flag} requires a value`);
        if (values.has(flag)) throw new Error(`${flag} may only be used once`);
        values.set(flag, value);
    }
    return values;
}

function integer(value, flag) {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
    return parsed;
}

export function peerRequest(args) {
    const [command, ...rest] = args;
    if (!command || command === 'help' || command === '--help' || command === '-h') return undefined;
    if (!['list', 'read', 'status', 'watch', 'prompt'].includes(command)) throw new Error(`Unknown peers command: ${command}`);
    const value = options(rest);
    const allowed = {
        list: ['--machine'],
        read: ['--machine', '--agent', '--lines'],
        status: ['--machine', '--agent'],
        watch: ['--machine', '--agent', '--timeout-ms'],
        prompt: ['--machine', '--agent', '--text'],
    }[command];
    for (const flag of value.keys()) if (!allowed.includes(flag)) throw new Error(`${flag} is not valid for peers ${command}`);
    const machine = value.get('--machine');
    const agent = value.get('--agent');
    if (command !== 'list' && !machine) throw new Error(`${command} requires --machine <name>`);
    if (command === 'list') return { method: 'list', ...(machine ? { machine } : {}) };
    if (command === 'read') return { method: 'read', machine, ...(agent ? { agent } : {}), ...(value.has('--lines') ? { lines: integer(value.get('--lines'), '--lines') } : {}) };
    if (command === 'status') return { method: 'status', machine, ...(agent ? { agent } : {}) };
    if (command === 'watch') return { method: 'watch', machine, ...(agent ? { agent } : {}), ...(value.has('--timeout-ms') ? { timeoutMs: integer(value.get('--timeout-ms'), '--timeout-ms') } : {}) };
    const text = value.get('--text');
    if (!text?.trim()) throw new Error('prompt requires --text <prompt>');
    return { method: 'prompt', machine, ...(agent ? { agent } : {}), text };
}

export function callPeerBroker(request, access = readAccess()) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(access.socketPath);
        const id = `cli-${randomUUID()}`;
        let input = '';
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) reject(error); else resolve(value);
        };
        const timeoutMs = request.method === 'watch'
            ? Math.min(Math.max(request.timeoutMs ?? 30_000, 1_000), 290_000) + 30_000
            : request.method === 'prompt' ? 330_000 : 60_000;
        socket.setTimeout(timeoutMs, () => finish(new Error('Peer request timed out.')));
        socket.on('connect', () => socket.write(`${JSON.stringify({ id, capability: access.capability, request })}\n`));
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            let response;
            try { response = JSON.parse(input.slice(0, newline)); } catch { return finish(new Error('Peer broker returned an invalid response.')); }
            if (response?.id !== id || response.ok !== true) return finish(new Error(response?.error || 'Peer request failed.'));
            if (typeof response.ackId !== 'string') return finish(undefined, response.data);
            socket.write(`${JSON.stringify({ id, capability: access.capability, ack: response.ackId })}\n`, (error) => finish(error || undefined, response.data));
        });
        socket.on('error', () => finish(new Error('Peer access is unavailable. Run `muxr daemon restart` and try again.')));
        socket.on('close', () => finish(new Error('Peer broker closed before replying.')));
    });
}

export async function listPeerMachines(command = {}) {
    return callPeerBroker({ method: 'list', ...(command.machine ? { machine: command.machine } : {}) });
}

export async function readPeerSession(command) {
    return callPeerBroker({
        method: 'read',
        machine: command.machine,
        ...(command.agent ? { agent: command.agent } : {}),
        ...(command.lines ? { lines: command.lines } : {}),
    });
}

export async function inspectPeerAgent(command) {
    return callPeerBroker({
        method: 'status',
        machine: command.machine,
        ...(command.agent ? { agent: command.agent } : {}),
    });
}

export async function watchPeerAgent(command) {
    return callPeerBroker({
        method: 'watch',
        machine: command.machine,
        ...(command.agent ? { agent: command.agent } : {}),
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
    });
}

export async function promptPeerAgent(command) {
    return callPeerBroker({
        method: 'prompt',
        machine: command.machine,
        ...(command.agent ? { agent: command.agent } : {}),
        text: command.text,
    });
}

export async function runPeers(args) {
    const request = peerRequest(args);
    if (request === undefined) {
        process.stdout.write(HELP);
        return;
    }
    let result;
    if (request.method === 'list') result = await listPeerMachines(request);
    else if (request.method === 'read') result = await readPeerSession(request);
    else if (request.method === 'status') result = await inspectPeerAgent(request);
    else if (request.method === 'watch') result = await watchPeerAgent(request);
    else result = await promptPeerAgent(request);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export const PEERS_HELP = HELP;
