/**
 * Flow-level check: handshake like the host bridge, then the HERDR_BIN argv
 * the host actually spawns. No test framework.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGraphics, frame, uint, DEFAULT_WORLD } from './graphics.mjs';
import { writeBinShim } from './bin.mjs';

const PROTOCOL_VERSION = 20;
const BIN = fileURLToPath(new URL('./bin.mjs', import.meta.url));

function clientHello(geometry) {
    return Buffer.concat([
        uint(0), uint(PROTOCOL_VERSION), uint(geometry.cols), uint(geometry.rows),
        uint(geometry.cellWidthPx), uint(geometry.cellHeightPx), uint(1), uint(0), uint(1),
    ]);
}

class Reader {
    offset = 0;
    constructor(value) { this.value = value; }
    uint() {
        const prefix = this.value[this.offset++];
        if (prefix === undefined) throw new Error('truncated bincode integer');
        if (prefix <= 250) return BigInt(prefix);
        if (prefix === 251) {
            const result = this.value.readUInt16LE(this.offset);
            this.offset += 2;
            return BigInt(result);
        }
        if (prefix === 252) {
            const result = this.value.readUInt32LE(this.offset);
            this.offset += 4;
            return BigInt(result);
        }
        if (prefix === 253) {
            const result = this.value.readBigUInt64LE(this.offset);
            this.offset += 8;
            return result;
        }
        throw new Error('unsupported bincode integer');
    }
    number() { return Number(this.uint()); }
    boolean() { return this.byte() !== 0; }
    byte() {
        const result = this.value[this.offset++];
        if (result === undefined) throw new Error('truncated bincode byte');
        return result;
    }
    bytes() {
        const length = this.number();
        const result = this.value.subarray(this.offset, this.offset + length);
        if (result.length !== length) throw new Error('truncated bincode bytes');
        this.offset += length;
        return result;
    }
    string() { return this.bytes().toString('utf8'); }
    option(read) { return this.byte() === 0 ? undefined : read(); }
}

function decodeServerMessage(payload) {
    const reader = new Reader(payload);
    switch (reader.number()) {
        case 0: {
            const version = reader.number();
            reader.number();
            const error = reader.option(() => reader.string());
            return { type: 'welcome', version, ...(error === undefined ? {} : { error }) };
        }
        case 2: {
            reader.uint();
            reader.number();
            reader.number();
            reader.boolean();
            return { type: 'output', bytes: reader.bytes() };
        }
        default:
            return { type: 'other' };
    }
}

function readFrames(socket, onMessage) {
    let input = Buffer.alloc(0);
    socket.on('data', (data) => {
        input = Buffer.concat([input, data]);
        while (input.length >= 4) {
            const length = input.readUInt32LE(0);
            if (input.length < length + 4) return;
            const payload = input.subarray(4, length + 4);
            input = input.subarray(length + 4);
            onMessage(decodeServerMessage(payload));
        }
    });
}

function fail(message) {
    throw new Error(message);
}

async function handshake(socketPath) {
    const socket = createConnection(socketPath);
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const messages = [];
    readFrames(socket, (message) => messages.push(message));
    socket.write(frame(clientHello({ cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 })));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        const welcome = messages.find((message) => message.type === 'welcome');
        const images = messages.filter((message) =>
            message.type === 'output'
            && message.bytes?.includes(0x1b)
            && message.bytes.toString('latin1').includes('\u001b_G'));
        if (welcome !== undefined && images.length >= 2) {
            socket.end();
            return { welcome, images };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    socket.destroy();
    fail(`handshake incomplete: ${JSON.stringify(messages.map((message) => message.type))}`);
}

function collectLines(child, { min, timeoutMs, env }) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`timed out waiting for ${min} NDJSON lines`));
        }, timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            stdout += chunk;
            const lines = stdout.split('\n').filter((line) => line.trim() !== '');
            if (lines.length >= min) {
                clearTimeout(timer);
                resolve({ child, lines, stdout });
            }
        });
        child.stderr?.setEncoding('utf8');
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('exit', (code) => {
            if (child.killed) return;
            clearTimeout(timer);
            if (linesOr(stdout).length >= min) resolve({ child, lines: linesOr(stdout), stdout });
            else reject(new Error(`exited ${code} before ${min} lines: ${stdout}`));
        });
        void env;
    });
}

function linesOr(stdout) {
    return stdout.split('\n').filter((line) => line.trim() !== '');
}

async function runBin(args, { env, waitLines, timeoutMs = 2000 } = {}) {
    const child = spawn(process.execPath, [BIN, ...args], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (waitLines === undefined) {
        const stdout = await new Promise((resolve, reject) => {
            let out = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => { out += chunk; });
            child.on('error', reject);
            child.on('close', () => resolve(out));
        });
        return { stdout, child };
    }
    return collectLines(child, { min: waitLines, timeoutMs, env });
}

const dir = mkdtempSync(join(tmpdir(), 'fake-herdr-g-'));
const socketPath = join(dir, 'herdr-client.sock');
const graphics = await startGraphics({ socketPath, world: DEFAULT_WORLD, frameHz: 4 });
try {
    const { welcome, images } = await handshake(socketPath);
    if (welcome.version !== PROTOCOL_VERSION) fail(`welcome version ${welcome.version}`);
    if (welcome.error !== undefined) fail(`welcome error ${welcome.error}`);
    if (images.length < 2) fail(`expected two image frames, got ${images.length}`);

    writeBinShim({ dir, socketPath: join(dir, 'missing.sock') });

    const list = await runBin(['pane', 'list']);
    const parsed = JSON.parse(list.stdout);
    if (!Array.isArray(parsed.result?.panes)) fail(`pane list not parseable: ${list.stdout}`);

    const session = await runBin(
        ['terminal', 'session', 'control', 'p1', '--takeover', '--cols', '80', '--rows', '24'],
        { env: { FAKE_HERDR_TERMINAL_BPS: '4096' }, waitLines: 3, timeoutMs: 2000 },
    );
    const records = session.lines.map((line) => JSON.parse(line));
    if (records[0]?.type !== 'terminal.ready') fail(`missing terminal.ready: ${session.lines[0]}`);
    const frames = records.filter((record) => record.type === 'terminal.frame');
    if (frames.length < 2) fail(`expected terminal.frame stream, got ${JSON.stringify(records.map((r) => r.type))}`);
    for (const record of frames) {
        if (typeof record.bytes !== 'string' || Buffer.from(record.bytes, 'base64').length === 0) {
            fail('terminal.frame bytes missing');
        }
    }
    session.child.stdin.end();
    await new Promise((resolve) => session.child.once('close', resolve));
} finally {
    graphics.close();
    rmSync(dir, { recursive: true, force: true });
}

console.log('fake-herdr graphics smoke ok');
