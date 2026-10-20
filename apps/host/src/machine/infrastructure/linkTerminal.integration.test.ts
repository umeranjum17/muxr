/**
 * Terminal and realtime voice over the byokit link, against a real relay and
 * host-side stream machinery. The fake herdr bin plays the pane; everything
 * between the phone-shaped DeviceLink and the pane is the real code.
 *
 * Owns the relay it starts: in-process, port 0, real port from the handle.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HerdrKit } from '@byokit/herdr';
import { DeviceLink, hostId, keyPairFrom, type DeviceGrant, type LinkStatus } from '@byokit/pair';
import type { HostFrame } from '@trymuxr/contract';
import { generateKeyPair, generateSigningKeyPair } from '@trymuxr/crypto';
import { startRelay } from '@muxr/relay';
import { VoiceStreamManager, TerminalManager, type VoiceStreamTransport } from '../../agent/index.js';
import { LinkEndpoint } from './linkEndpoint.js';
import type { MachineCryptoState } from '../domain/crypto.js';
import { removeTestScratch } from '../../../../../scripts/diagnostics/application/testScratchOwner.mjs';

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64');
/** @trymuxr/crypto keys are base64 strings; byokit wants base64url bytes. */
const toB64url = (valueBase64: string): string => Buffer.from(valueBase64, 'base64').toString('base64url');

/**
 * A drag is only done once its rows have paid out and the count holds still.
 * One quiet poll can be a stalled host mid-drag, so require the expected floor
 * before trusting the count as final.
 */
async function waitForDrag(count: () => number, atLeast: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
        const now = count();
        if (now >= atLeast && now === last) return;
        last = now;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

/**
 * The pane: paints a full screen, echoes input, repaints on resize, and scrolls
 * like a full-screen program -- it repaints on a wheel report only while there
 * is transcript left that way (100 rows), and logs every report it is handed.
 */
function writeFakeHerdr(dir: string, ownsScroll = false): string {
    const bin = join(dir, 'fake-herdr.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pane = args[3];
const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : Number(args[i + 1]); };
let cols = option('--cols');
let rows = option('--rows');
const b64 = (s) => Buffer.from(s).toString('base64');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
send({ type: 'terminal.frame', full: true, bytes: b64(\`SCREEN \${pane} \${cols}x\${rows}\`) });
let buffer = '';
let back = 0;
const scrollFile = ${JSON.stringify(join(dir, 'scroll.json'))};
const ownsScroll = ${ownsScroll};
const wheelLog = ${JSON.stringify(join(dir, 'wheel.log'))};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === 'terminal.input' && typeof frame.text === 'string') {
            send({ type: 'terminal.frame', bytes: b64(frame.text) });
        } else if (frame.type === 'terminal.resize') {
            cols = frame.cols;
            rows = frame.rows;
            send({ type: 'terminal.frame', bytes: b64(\`SCREEN \${pane} \${cols}x\${rows}\`) });
        } else if (frame.type === 'terminal.scroll') {
            appendFileSync(wheelLog, frame.direction + ' ' + Date.now() + '\\n');
            if (ownsScroll) {
                const state = JSON.parse(readFileSync(scrollFile, 'utf8'));
                state.offsetFromBottom += state.burst;
                state.burst = 0;
                state.offsetFromBottom = Math.max(0, state.offsetFromBottom - frame.lines);
                writeFileSync(scrollFile, JSON.stringify(state));
                send({ type: 'terminal.frame', bytes: b64('OFFSET ' + state.offsetFromBottom) });
                continue;
            }
            const moved = frame.direction === 'up' ? Math.min(100, back + frame.lines) : Math.max(0, back - frame.lines);
            if (moved === back) continue;
            back = moved;
            send({ type: 'terminal.frame', bytes: b64(\`SCROLL \${frame.direction} \${frame.lines}\`) });
        } else if (frame.type === 'terminal.release') {
            process.exit(0);
        }
    }
});
`, { mode: 0o755 });
    return bin;
}

/** Kit-backed terminal opener over a stub herdr bin. The K6 `path` entry is
 * what lets the `#!/usr/bin/env node` stub resolve node; without it the kit's
 * fixed adopt PATH cannot spawn the stub. */
function openTerminalFor(bin: string) {
    const kit = new HerdrKit({
        mode: 'adopt',
        bin,
        socketPath: join(tmpdir(), 'muxr-terminal-test-unused.sock'),
        path: [dirname(process.execPath)],
    });
    return (paneId: string, opts: { mode: 'control' | 'observe'; cols: number; rows: number }) =>
        kit.terminal(paneId, opts);
}

function once<T>(target: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        target,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
    ]);
}

describe('byokit link streams (real relay + real host)', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()!();
    });

    /**
     * Waits until the manager has settled the pane's scroll ownership and
     * relayed it to the phone. A drag fed before this is handed straight to the
     * program instead of the wheel, so the wait replaces a fixed settle that was
     * too short under a loaded runner with the observable that the terminal is
     * adopted and the wheel path is live.
     */
    const waitForScreen = async (frames: unknown[], ms = 8_000): Promise<void> => {
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                const ready = frames.some((frame) => typeof frame === 'object' && frame !== null
                    && (frame as { type?: unknown }).type === 'terminal.scroll-state');
                if (ready) { clearInterval(timer); resolve(); }
            }, 10);
            cleanups.push(() => clearInterval(timer));
        }), ms, 'pane scroll-state');
    };

    it('holds a streaming pane at a slow phone instead of queueing its whole output', { timeout: 15_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-pressure-'));
        cleanups.push(() => removeTestScratch(dir));
        const bin = join(dir, 'stream.mjs');
        writeFileSync(bin, `#!/usr/bin/env node
for (let i = 0; i < 200; i++) process.stdout.write(JSON.stringify({ type: 'terminal.frame', full: i === 0, bytes: 'a'.repeat(4096) }) + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            openTerminal: openTerminalFor(bin),
        });
        cleanups.push(() => manager.closeAll());
        let sent = 0;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        cleanups.push(release);
        const socket = {
            isOpen: true,
            send: () => { sent++; return blocked; },
            onLine: () => () => undefined,
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'slow', cols: 20, rows: 5, socket });
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => { if (sent > 0) { clearInterval(timer); resolve(); } }, 10);
        }), 3000, 'first frame');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(sent).toBe(1);
        release();
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => { if (sent === 200) { clearInterval(timer); resolve(); } }, 10);
        }), 3000, 'stream resume');
        expect(sent).toBe(200);
    });

    it('finishes Latest against the pane after output outruns the phone offset', { timeout: 10_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-bottom-'));
        cleanups.push(() => removeTestScratch(dir));
        const scrollFile = join(dir, 'scroll.json');
        writeFileSync(scrollFile, JSON.stringify({ offsetFromBottom: 100, maxOffsetFromBottom: 5_000, burst: 2_500 }));
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => JSON.parse(readFileSync(scrollFile, 'utf8')),
            openTerminal: openTerminalFor(writeFakeHerdr(dir, true)),
        });
        cleanups.push(() => manager.closeAll());
        let input!: (line: string) => void;
        const results: Array<{ type: string; state?: string }> = [];
        const socket = {
            isOpen: true,
            send: (line: string) => { results.push(JSON.parse(line)); },
            onLine: (listener: (line: string) => void) => { input = listener; return () => undefined; },
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'bottom', cols: 20, rows: 5, socket });
        input(JSON.stringify({ type: 'terminal.bottom', requestId: 'burst-bottom' }));
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                if (results.some((frame) => frame.type === 'terminal.bottom-state' && frame.state === 'complete')) {
                    clearInterval(timer);
                    resolve();
                }
            }, 10);
            cleanups.push(() => clearInterval(timer));
        }), 4_000, 'Latest completion');
        expect(JSON.parse(readFileSync(scrollFile, 'utf8')).offsetFromBottom).toBe(0);
        expect(results).toContainEqual({ type: 'terminal.bottom-state', requestId: 'burst-bottom', state: 'catching-up' });
        expect(results).toContainEqual({ type: 'terminal.bottom-state', requestId: 'burst-bottom', state: 'complete' });
        expect(readFileSync(join(dir, 'wheel.log'), 'utf8').trim().split('\n')).toHaveLength(2);
    });

    it('keeps a streaming full-screen program under the finger and finishes Latest at its live edge', { timeout: 20_000 }, async () => {
        // The pane plays OpenCode scrolled back into its transcript: three
        // rows per wheel report, a new line every 50 ms it follows only at the
        // live edge, and a repaint on every line. Away from the live edge its
        // own output does not move the view, so the step is measurable.
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-stream-wheel-'));
        // The program may still be painting while it exits; the shared
        // removal re-reads the tree and never fails the test.
        cleanups.push(() => removeTestScratch(dir));
        const bin = join(dir, 'fake-herdr.mjs');
        const screenFile = join(dir, 'screen.txt');
        const stateFile = join(dir, 'state.json');
        writeFileSync(bin, `#!/usr/bin/env node
import { renameSync, writeFileSync } from 'node:fs';
// Whole files only: the host and the test read them while this paints.
const save = (path, text) => { writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path); };
const lines = Array.from({ length: 200 }, (_, i) => 'line ' + (i + 1));
let back = 30;
let moved = 0;
const paint = (full) => {
    const end = lines.length - back;
    const body = lines.slice(end - 8, end);
    save(${JSON.stringify(screenFile)}, ['OPENCODE', ...body, 'ask anything'].join('\\n'));
    save(${JSON.stringify(stateFile)}, JSON.stringify({ back, moved }));
    process.stdout.write(JSON.stringify({ type: 'terminal.frame', full, bytes: Buffer.from(body.at(-1)).toString('base64') }) + '\\n');
};
paint(true);
setInterval(() => { lines.push('line ' + (lines.length + 1)); if (back > 0) back += 1; paint(false); }, 50);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
        const frame = JSON.parse(buffer.slice(0, nl) || '{}');
        buffer = buffer.slice(nl + 1);
        if (frame.type === 'terminal.release') process.exit(0);
        if (frame.type !== 'terminal.scroll') continue;
        // Painted late, as on a busy host, while its own output keeps painting.
        setTimeout(() => {
            const next = frame.direction === 'up' ? Math.min(lines.length - 8, back + 3 * frame.lines) : Math.max(0, back - 3 * frame.lines);
            moved += Math.abs(next - back);
            back = next;
            paint(false);
        }, 300);
    }
});
`, { mode: 0o755 });
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            readPaneText: async () => readFileSync(screenFile, 'utf8'),
            openTerminal: openTerminalFor(bin),
        });
        cleanups.push(() => manager.closeAll());
        let input!: (line: string) => void;
        const results: Array<{ type: string; state?: string }> = [];
        const socket = {
            isOpen: true,
            send: (line: string) => { results.push(JSON.parse(line)); },
            onLine: (listener: (line: string) => void) => { input = listener; return () => undefined; },
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'stream-wheel', cols: 20, rows: 10, socket });
        const state = (): { back: number; moved: number } => JSON.parse(readFileSync(stateFile, 'utf8'));
        await waitForScreen(results);

        // A 30-row drag moves the program 30 rows, not three times that.
        input(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 30, column: 10, row: 5 }));
        await waitForDrag(() => state().moved, 27, 12_000);
        expect(state().moved).toBeGreaterThanOrEqual(27);
        expect(state().moved).toBeLessThanOrEqual(36);

        // Latest reaches the live edge and says so, though the program never stops painting.
        input(JSON.stringify({ type: 'terminal.bottom', requestId: 'stream-bottom' }));
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                if (results.some((frame) => frame.type === 'terminal.bottom-state' && frame.state === 'complete')) {
                    clearInterval(timer);
                    resolve();
                }
            }, 10);
            cleanups.push(() => clearInterval(timer));
        }), 4_000, 'Latest completion');
        expect(state().back).toBe(0);
    });

    it('stops a fling the moment its program exits instead of typing the rest into the shell', { timeout: 20_000 }, async () => {
        // A 500-row fling starts against a live full-screen program. The program
        // exits mid-drain, so Herdr's foreground becomes the pane's own shell,
        // and the rows still owed must not reach that shell as wheel reports.
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-exit-wheel-'));
        cleanups.push(() => removeTestScratch(dir));
        const exitFile = join(dir, 'agent-exited');
        const wheelLog = join(dir, 'wheel.log');
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            paneForegroundPids: async () => (existsSync(exitFile) ? [] : [4242]),
            openTerminal: openTerminalFor(writeFakeHerdr(dir)),
        });
        cleanups.push(() => manager.closeAll());
        let input!: (line: string) => void;
        const results: Array<{ type: string; state?: string }> = [];
        const socket = {
            isOpen: true,
            send: (line: string) => { results.push(JSON.parse(line)); },
            onLine: (listener: (line: string) => void) => { input = listener; return () => undefined; },
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'exit-wheel', cols: 20, rows: 10, socket });
        await waitForScreen(results);

        const reportTimes = (): number[] => (existsSync(wheelLog) ? readFileSync(wheelLog, 'utf8') : '')
            .split('\n').filter(Boolean).map((line) => Number(line.split(' ')[1]));
        input(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 500, column: 10, row: 5 }));
        const deadline = Date.now() + 5_000;
        while (reportTimes().length < 20 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(reportTimes().length).toBeGreaterThanOrEqual(20);

        const exitedAt = Date.now();
        writeFileSync(exitFile, '');
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // One burst may already be past the foreground probe when the exit lands.
        expect(reportTimes().filter((at) => at > exitedAt).length).toBeLessThanOrEqual(4);
    });

    it('learns the program wheel step after a failed pane read', { timeout: 20_000 }, async () => {
        // The pane plays OpenCode: three rows per wheel report, repainting the
        // screen only when a report moves it. The first pane-text read fails as
        // a transient herdr read does, and the step must still be learned.
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-read-fail-'));
        cleanups.push(() => removeTestScratch(dir));
        const bin = join(dir, 'fake-herdr.mjs');
        const screenFile = join(dir, 'screen.txt');
        const stateFile = join(dir, 'state.json');
        writeFileSync(bin, `#!/usr/bin/env node
import { renameSync, writeFileSync } from 'node:fs';
// Whole files only: the host and the test read them while this paints.
const save = (path, text) => { writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path); };
const lines = Array.from({ length: 200 }, (_, i) => 'line ' + (i + 1));
let back = 0;
let moved = 0;
const paint = (full) => {
    const end = lines.length - back;
    const body = lines.slice(end - 8, end);
    save(${JSON.stringify(screenFile)}, ['OPENCODE', ...body, 'ask anything'].join('\\n'));
    save(${JSON.stringify(stateFile)}, JSON.stringify({ back, moved }));
    process.stdout.write(JSON.stringify({ type: 'terminal.frame', full, bytes: Buffer.from(body.at(-1)).toString('base64') }) + '\\n');
};
paint(true);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
        const frame = JSON.parse(buffer.slice(0, nl) || '{}');
        buffer = buffer.slice(nl + 1);
        if (frame.type === 'terminal.release') process.exit(0);
        if (frame.type !== 'terminal.scroll') continue;
        // Painted late, as on a busy host.
        setTimeout(() => {
            const next = frame.direction === 'up' ? Math.min(lines.length - 8, back + 3 * frame.lines) : Math.max(0, back - 3 * frame.lines);
            moved += Math.abs(next - back);
            back = next;
            paint(false);
        }, 300);
    }
});
`, { mode: 0o755 });
        let textReads = 0;
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            readPaneText: async () => {
                textReads += 1;
                if (textReads === 1) throw new Error('pane text unreadable');
                return readFileSync(screenFile, 'utf8');
            },
            openTerminal: openTerminalFor(bin),
        });
        cleanups.push(() => manager.closeAll());
        let input!: (line: string) => void;
        const frames: unknown[] = [];
        const socket = {
            isOpen: true,
            send: (line: string) => { frames.push(JSON.parse(line)); },
            onLine: (listener: (line: string) => void) => { input = listener; return () => undefined; },
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'read-fail', cols: 20, rows: 10, socket });
        const state = (): { back: number; moved: number } => JSON.parse(readFileSync(stateFile, 'utf8'));
        await waitForScreen(frames);

        // A 30-row drag moves the program 30 rows, not three times that, even
        // though the first read of its screen threw.
        input(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 30, column: 10, row: 5 }));
        await waitForDrag(() => state().moved, 27, 12_000);
        expect(textReads).toBeGreaterThan(1);
        expect(state().moved).toBeGreaterThanOrEqual(27);
        expect(state().moved).toBeLessThanOrEqual(36);
    });

    it('keeps an accelerating full-screen program under the finger and stops with it', { timeout: 20_000 }, async () => {
        // The pane plays Claude Code: reports that reach it under 40 ms apart
        // are one fast spin, a row each for the first four and more after
        // that, painted 35 ms later. A phone drag of 60 rows must move it 60.
        const dir = mkdtempSync(join(tmpdir(), 'muxr-terminal-accelerate-'));
        cleanups.push(() => removeTestScratch(dir));
        const bin = join(dir, 'fake-herdr.mjs');
        const screenFile = join(dir, 'screen.txt');
        const stateFile = join(dir, 'state.json');
        writeFileSync(bin, `#!/usr/bin/env node
import { renameSync, writeFileSync } from 'node:fs';
const save = (path, text) => { writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path); };
const lines = Array.from({ length: 400 }, (_, i) => 'line ' + (i + 1));
let back = 0;
let spin = 0;
let lastReport = 0;
const paint = (full) => {
    const end = lines.length - back;
    const body = lines.slice(end - 20, end);
    save(${JSON.stringify(screenFile)}, ['CLAUDE', ...body, '> '].join('\\n'));
    save(${JSON.stringify(stateFile)}, JSON.stringify({ back }));
    process.stdout.write(JSON.stringify({ type: 'terminal.frame', full, bytes: Buffer.from(body.at(-1)).toString('base64') }) + '\\n');
};
paint(true);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
        const frame = JSON.parse(buffer.slice(0, nl) || '{}');
        buffer = buffer.slice(nl + 1);
        if (frame.type === 'terminal.release') process.exit(0);
        if (frame.type !== 'terminal.scroll') continue;
        spin = Date.now() - lastReport < 40 ? spin + 1 : 0;
        lastReport = Date.now();
        const rows = spin < 4 ? 1 : spin < 6 ? 2 : 3;
        back = frame.direction === 'up' ? Math.min(lines.length - 20, back + rows) : Math.max(0, back - rows);
        setTimeout(() => paint(false), 35);
    }
});
`, { mode: 0o755 });
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            readPaneText: async () => readFileSync(screenFile, 'utf8'),
            openTerminal: openTerminalFor(bin),
        });
        cleanups.push(() => manager.closeAll());
        let input!: (line: string) => void;
        const frames: unknown[] = [];
        const socket = {
            isOpen: true,
            send: (line: string) => { frames.push(JSON.parse(line)); },
            onLine: (listener: (line: string) => void) => { input = listener; return () => undefined; },
            onEnd: () => () => undefined,
            close: () => undefined,
        };
        await manager.attach({ sessionId: 's1', channel: 'accelerate', cols: 20, rows: 22, socket });
        const back = (): number => (JSON.parse(readFileSync(stateFile, 'utf8')) as { back: number }).back;
        await waitForScreen(frames);

        // The finger moves 6 rows every 100 ms for a second.
        for (let i = 0; i < 10; i++) {
            input(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 6, column: 10, row: 5 }));
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await waitForDrag(back, 57, 8_000);
        expect(back()).toBeGreaterThanOrEqual(57);
        expect(back()).toBeLessThanOrEqual(63);
    });

    it('drops every input a view-only device sends', { timeout: 30_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-view-'));
        cleanups.push(() => removeTestScratch(dir));
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay') } });
        cleanups.push(() => void relay.close());
        const machine = generateKeyPair();
        const machineSigning = generateSigningKeyPair();
        const phone = generateKeyPair();
        const crypto: MachineCryptoState = {
            signingPublicKey: machineSigning.publicKey,
            signingSecretKey: machineSigning.secretKey,
            boxPublicKey: machine.publicKey,
            boxSecretKey: machine.secretKey,
            dataKey: b64(new Uint8Array(32)),
            keyVersion: 1,
            // A browser record stored without an authority is view-only.
            devices: [{
                deviceId: 'dev-watcher',
                kind: 'browser',
                devicePublicKey: phone.publicKey,
                ingressKey: 'ingress',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            }],
        };
        const terminals = new TerminalManager({
            resolvePane: async (sessionId) => `pane-${sessionId}`,
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            openTerminal: openTerminalFor(writeFakeHerdr(dir)),
        });
        cleanups.push(() => terminals.closeAll());
        const answered: string[] = [];
        const endpoint = await LinkEndpoint.open({
            relayUrl: `ws://127.0.0.1:${relay.port}/relay`,
            ownerToken: JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string,
            machineName: 'test machine',
            crypto,
            currentCrypto: () => crypto,
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            // The desktop engine applies input from any session it opens, so a
            // watcher's desktop signaling must never reach the host's answer.
            answer: async (frame) => { answered.push(frame.type); return undefined; },
            canView: () => false,
            terminals: {
                attach: (params) => terminals.attach(params),
                sendResult: (socket, channel, result) => terminals.sendResult(socket, channel, result),
            },
        });
        endpoint!.start();
        cleanups.push(() => endpoint!.close());
        const link = new DeviceLink({
            v: 1,
            secretKey: toB64url(phone.secretKey),
            host: toB64url(machine.publicKey),
            hostName: 'test machine',
            urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(keyPairFrom(Buffer.from(machine.secretKey, 'base64')).publicKey)}`],
            device: { id: '', name: 'Watcher', role: 'view' },
        });
        cleanups.push(() => link.stop());
        await once(new Promise<void>((resolve) => {
            const timer = setInterval(() => { if (link.status === 'online') { clearInterval(timer); resolve(); } }, 50);
        }), 15_000, 'watcher link online');
        const lines = (stream: { onData?: (chunk: Uint8Array) => void }): string[] => {
            const seen: string[] = [];
            let buffer = '';
            stream.onData = (chunk) => {
                buffer += Buffer.from(chunk).toString('utf8');
                const parts = buffer.split('\n');
                buffer = parts.pop() ?? '';
                seen.push(...parts.filter(Boolean));
            };
            return seen;
        };
        const until = (check: () => boolean, what: string): Promise<void> => once(new Promise<void>((resolve) => {
            const timer = setInterval(() => { if (check()) { clearInterval(timer); resolve(); } }, 50);
        }), 5_000, what);

        // It asks to control the pane and types: it watches, and the pane hears nothing.
        const pane = await link.stream('terminal', { requestId: 'lv-1', sessionId: 's1', channel: 'tm_view_1', cols: 20, rows: 5, mode: 'control', takeover: true });
        const painted = lines(pane);
        await until(() => painted.some((line) => line.includes('"type":"result"')) && painted.length >= 2, 'watcher attach and paint');
        expect(JSON.parse(painted.find((line) => line.includes('"type":"result"'))!)).toMatchObject({ ok: true, data: { paneId: 'pane-s1' } });
        const before = painted.length;
        await pane.write(`${JSON.stringify({ type: 'terminal.input', text: 'rm -rf typed by a watcher\r' })}\n`);
        await pane.write(`${JSON.stringify({ type: 'terminal.resize', cols: 40, rows: 12 })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(painted.slice(before).filter((line) => line.includes('"terminal.frame"'))).toEqual([]);

        // It opens the desktop asking only to view: refused before the engine.
        const desktop = await link.stream('desktop', {});
        const replies = lines(desktop);
        await desktop.write(`${JSON.stringify({ type: 'desktop.open', requestId: 'lv-2', params: { permissions: ['view'] } })}\n`);
        await until(() => replies.length > 0, 'desktop refusal');
        expect(JSON.parse(replies[0]!)).toMatchObject({ type: 'result', requestId: 'lv-2', ok: false, code: 'permission-denied' });

        // It asks the host to run an agent action: refused by the grant before
        // the engine, so the host's answer callback never sees the frame.
        await expect(link.request('session.prompt', { type: 'session.prompt', requestId: 'lv-3', params: { sessionId: 's1', text: 'rm -rf typed by a watcher' } }))
            .rejects.toMatchObject({ code: 'view-only' });
        expect(answered).toEqual([]);
    });

    it('carries terminal and voice streams over the byokit link', { timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'muxr-link-terminal-'));
        cleanups.push(() => removeTestScratch(dir));
        const herdrBin = writeFakeHerdr(dir);
        const relay = await startRelay({ port: 0, config: { dataDir: join(dir, 'relay') } });
        cleanups.push(() => void relay.close());
        const relayUrl = `ws://127.0.0.1:${relay.port}/relay`;
        const base = `http://127.0.0.1:${relay.port}`;
        const health = await (await fetch(`${base}/health`)).json() as { muxrVersion: string; linkProtocol: number };
        expect(health.linkProtocol).toBe(1);
        expect(health.muxrVersion).toMatch(/^\d+\.\d+\.\d+/);
        const oldGrant = await fetch(`${base}/v1/machines/old/grant`);
        expect(oldGrant.status).toBe(410);
        expect((await oldGrant.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('Update the muxr app') });
        const oldTicket = await fetch(`${base}/v1/ws-tickets`, { method: 'POST' });
        expect(oldTicket.status).toBe(403); // 0.2.0 maps this to its fixed re-pair message.
        const ownerToken = JSON.parse(readFileSync(join(dir, 'relay', 'mint-secret'), 'utf8')) as string;

        const machine = generateKeyPair();
        const machineSigning = generateSigningKeyPair();
        const phone = generateKeyPair();
        const crypto: MachineCryptoState = {
            signingPublicKey: machineSigning.publicKey,
            signingSecretKey: machineSigning.secretKey,
            boxPublicKey: machine.publicKey,
            boxSecretKey: machine.secretKey,
            dataKey: b64(new Uint8Array(32)),
            keyVersion: 1,
            devices: [{
                deviceId: 'dev-phone',
                kind: 'browser',
                devicePublicKey: phone.publicKey,
                ingressKey: 'ingress',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                authority: 'control',
            }],
        };

        const voiceRoot = join(dir, 'voice-plugin');
        const voiceEntry = join(voiceRoot, 'stream.mjs');
        mkdirSync(voiceRoot, { recursive: true });
        writeFileSync(voiceEntry, `import readline from 'node:readline';\nconst input = readline.createInterface({ input: process.stdin });\ninput.on('line', (line) => { const frame = JSON.parse(line); if (frame.type === 'realtime.audio') process.stdout.write(JSON.stringify({ type: 'realtime.transcript', role: 'user', text: 'voice frame received' }) + '\\n'); });\n`);
        const voiceRuntime = new VoiceStreamManager({});
        cleanups.push(() => voiceRuntime.closeAll());

        const terminals = new TerminalManager({
            resolvePane: async (sessionId) => `pane-${sessionId}`,
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            openTerminal: openTerminalFor(herdrBin),
        });
        cleanups.push(() => terminals.closeAll());

        const endpoint = await LinkEndpoint.open({
            relayUrl,
            ownerToken,
            machineName: 'test machine',
            crypto,
            currentCrypto: () => crypto,
            savePushLevel: () => undefined,
            grants: { load: () => [], save: () => undefined },
            answer: async () => undefined,
            canView: () => false,
            terminals: {
                attach: (params) => terminals.attach(params),
                sendResult: (socket, channel, result) => terminals.sendResult(socket, channel, result),
            },
            voiceStreams: {
                attach: ({ deviceId, channel, sessionId, stream }) => voiceRuntime.attach({
                    target: { providerId: 'voice-test', runtimeRoot: voiceRoot, entry: 'stream.mjs' },
                    channel,
                    stateDir: join(dir, 'voice-state'),
                    ...(sessionId === undefined ? {} : { sessionId }),
                    deviceId,
                    transport: {
                        set onData(listener: VoiceStreamTransport['onData']) { stream.onData = listener; },
                        set onEnd(listener: VoiceStreamTransport['onEnd']) { stream.onEnd = listener; },
                        write: (chunk) => stream.write(chunk),
                        end: (error) => stream.end(error),
                    },
                    signal: new AbortController().signal,
                    onClosed: () => undefined,
                }),
            },
        });
        expect(endpoint).toBeDefined();
        endpoint!.start();
        cleanups.push(() => endpoint!.close());

        const machineKeys = keyPairFrom(Buffer.from(machine.secretKey, 'base64'));
        const phoneGrant: DeviceGrant = {
            v: 1,
            secretKey: toB64url(phone.secretKey),
            host: toB64url(machine.publicKey),
            hostName: 'test machine',
            urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(machineKeys.publicKey)}`],
            device: { id: '', name: 'Test phone', role: 'control' },
        };
        const statuses: LinkStatus[] = [];
        const link = new DeviceLink(phoneGrant, { onStatus: (s) => statuses.push(s) });
        cleanups.push(() => link.stop());
        await once(new Promise<void>((resolve, reject) => {
            const timer = setInterval(() => {
                if (link.status === 'online') { clearInterval(timer); resolve(); }
                if (statuses.includes('refused') || statuses.includes('removed')) { clearInterval(timer); reject(new Error(`link refused: ${statuses.join(',')}`)); }
            }, 50);
            setTimeout(() => { clearInterval(timer); reject(new Error(`link never came online: ${statuses.join(',')}`)); }, 15_000);
        }), 16_000, 'link online');

        // ---- Attach over the link: the stream open IS the attach. ----
        const channel = 'tm_test_1';
        const linkAttachStarted = Date.now();
        const stream = await link.stream('terminal', {
            requestId: 'lt-1',
            sessionId: 's1',
            channel,
            cols: 20,
            rows: 5,
            takeover: true,
        });
        let buffer = '';
        let ended = false;
        const pending: Array<{ resolve: (f: HostFrame) => void; reject: (e: Error) => void }> = [];
        const pump = (): void => {
            // Lines wait in the buffer until someone awaits them; nothing is dropped.
            while (pending.length > 0) {
                const nl = buffer.indexOf('\n');
                if (nl < 0) return;
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim()) continue;
                pending.shift()!.resolve(JSON.parse(line) as HostFrame);
            }
        };
        const nextFrame = (): Promise<HostFrame> => new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
            pump(); // may resolve immediately from an already-buffered line
            if (ended) reject(new Error('stream already ended'));
        });
        stream.onData = (chunk) => {
            buffer += Buffer.from(chunk).toString('utf8');
            pump();
        };
        stream.onEnd = (error) => {
            ended = true;
            for (const waiter of pending.splice(0)) waiter.reject(new Error(`stream ended before its frame (error: ${error ?? 'clean'})`));
        };
        let attachAck: HostFrame | undefined;
        let initialPaint: string | undefined;
        let linkAttachMs = 0;
        while (attachAck === undefined || initialPaint === undefined) {
            const frame = await once(nextFrame(), 10_000, 'link attach and initial paint') as HostFrame | { type: 'terminal.frame'; full?: boolean; bytes: string };
            if (frame.type === 'result') {
                attachAck = frame;
                linkAttachMs = Date.now() - linkAttachStarted;
            } else if (frame.type === 'terminal.frame' && frame.full === true) {
                initialPaint = Buffer.from(frame.bytes, 'base64').toString('utf8');
            }
        }
        expect(attachAck).toMatchObject({ type: 'result', ok: true, data: { paneId: 'pane-s1' } });
        expect(initialPaint).toBe('SCREEN pane-s1 20x5');

        // Frame bytes the pane painted, skipping anything else (scroll-state).
        const nextFrameBytes = async (what: string): Promise<string> => {
            const done = once((async () => {
                for (;;) {
                    // Terminal frames are the raw channel protocol, not envelope frames.
                    const frame = await nextFrame() as unknown as { type: string; bytes?: unknown };
                    if (frame.type === 'terminal.frame' && typeof frame.bytes === 'string') {
                        return Buffer.from(frame.bytes, 'base64').toString('utf8');
                    }
                }
            })(), 5_000, what);
            return done;
        };

        // Typing.
        const typed = 'hello over the link';
        await stream.write(`${JSON.stringify({ type: 'terminal.input', text: typed })}\n`);
        expect(await nextFrameBytes('echo')).toBe(typed);

        // Resize.
        await stream.write(`${JSON.stringify({ type: 'terminal.resize', cols: 40, rows: 12 })}\n`);
        expect(await nextFrameBytes('resize repaint')).toBe('SCREEN pane-s1 40x12');

        // A pane with no Herdr scrollback (Claude Code on the alternate
        // screen) gets a 30-row drag as 30 wheel reports. Herdr turns any one
        // scroll into a single report, which is how a fling or a jump to
        // Latest used to move Claude Code by one notch.
        // The host learns that from Herdr's scroll state, read just after the first paint.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 30, column: 10, row: 6 })}\n`);
        const reports: string[] = [];
        while (reports.length < 30) reports.push(await nextFrameBytes('wheel report'));
        expect(reports).toEqual(Array.from({ length: 30 }, () => 'SCROLL up 1'));
        const wheelLog = (): Array<[string, number]> => readFileSync(join(dir, 'wheel.log'), 'utf8').split('\n').filter(Boolean)
            .map((line) => { const [direction, at] = line.split(' '); return [direction!, Number(at)]; });
        // ...in bursts of four with a rest after each, so Claude Code does not
        // read them as one fast spin and multiply the drag.
        const drag = wheelLog().map(([, at]) => at);
        for (let i = 4; i < drag.length; i += 4) expect(drag[i]! - drag[i - 4]!).toBeGreaterThanOrEqual(40);

        // Latest reaches past the rows it counted, because output lands below
        // while the phone reads back. The wheel stops where the pane stops
        // repainting instead of turning out the whole reach at the bottom.
        const wheel = (): string[] => wheelLog().map(([direction]) => direction);
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: 2_030, column: 10, row: 6 })}\n`);
        const back: string[] = [];
        while (back.length < 30) back.push(await nextFrameBytes('wheel back to the bottom'));
        expect(back).toEqual(Array.from({ length: 30 }, () => 'SCROLL down 1'));
        await sleep(1_500);
        const settled = wheel().length;
        await sleep(500);
        expect(wheel().length).toBe(settled);
        expect(settled).toBeLessThan(1_000);

        // A finger that turns back is followed at once, not after the rows
        // still owed the other way.
        const turnedAt = wheel().length;
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 60, column: 10, row: 6 })}\n`);
        expect(await nextFrameBytes('wheel turning up')).toBe('SCROLL up 1');
        await stream.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: 5, column: 10, row: 6 })}\n`);
        while (await nextFrameBytes('wheel turned back') !== 'SCROLL down 1') { /* the ups already sent */ }
        await sleep(300);
        const turn = wheel().slice(turnedAt);
        const turnedBack = turn.indexOf('down');
        expect(turnedBack).toBeLessThan(60);
        expect(turn.slice(turnedBack)).toEqual(Array.from({ length: 5 }, () => 'down'));

        // Voice frames traverse the host stream adapter over the byokit link.
        const voice = await link.stream('voice', { channel: 'rs_linkvoice1234', sessionId: 's1' });
        const voiceReply = new Promise<string>((resolve, reject) => {
            let received = '';
            voice.onData = (chunk) => {
                received += Buffer.from(chunk).toString('utf8');
                if (received.includes('\n')) resolve(received.trim());
            };
            voice.onEnd = (error) => reject(new Error(`voice link ended: ${error ?? 'clean'}`));
        });
        const voiceStarted = Date.now();
        const voiceFrame = JSON.stringify({ type: 'realtime.audio', data: 'AQI=' });
        await voice.write(`${voiceFrame}\n`);
        expect(await once(voiceReply, 5_000, 'voice link round trip')).toBe(JSON.stringify({ type: 'realtime.transcript', role: 'user', text: 'voice frame received' }));
        const voiceLinkRttMs = Date.now() - voiceStarted;
        process.stdout.write(`voice link round trip: ${voiceLinkRttMs}ms\n`);
        expect(voiceLinkRttMs).toBeLessThan(5_000);

        // The authenticated link no longer exposes the retired plugin stream
        // operation; a client that still attempts it is rejected by the host.
        await expect(link.stream('plugin' as never, {
            pluginId: 'fixture', manifestHash: 'fixture-hash', contributionId: 'voice', channel: 'rs_plugin_test',
        } as never)).rejects.toThrow(/isn't allowed/i);

        expect(linkAttachMs).toBeLessThan(5_000);

        crypto.devices.splice(0);
        const revoked = await link.stream('terminal', {
            requestId: 'lt-revoked',
            sessionId: 's1',
            channel: 'tm_test_2',
            cols: 20,
            rows: 5,
            takeover: true,
        });
        const refusal = await once(new Promise<string>((resolve, reject) => {
            let received = '';
            revoked.onData = (chunk) => {
                received += Buffer.from(chunk).toString('utf8');
                if (received.includes('\n')) resolve(received.split('\n')[0]!);
            };
            revoked.onEnd = (error) => reject(new Error(`revoked stream ended: ${error ?? 'clean'}`));
        }), 5_000, 'revoked attach refusal');
        expect(JSON.parse(refusal)).toMatchObject({ type: 'result', requestId: 'lt-revoked', ok: false, code: 'device-revoked' });

        link.stop();
    });
});
