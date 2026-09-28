import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authorityEntry, firstFreeDisplayNumber, onPath, removeDisplayFiles, waitForDisplaySocket } from './x11Display.js';

const XVFB = 'Xvfb';
/** A light desktop session to run on it, when the machine has one installed. */
const SESSION = 'startxfce4';
const FIRST_NUMBER = 90;
const START_TIMEOUT_MS = 5000;

/**
 * The screen this host starts for a machine that has none, such as a cloud
 * server: a private Xvfb, with the light desktop session on it when one is
 * installed. It is started when a desktop opens, started again when it has
 * died or the machine rebooted, and stopped with the host. Its cookie keeps
 * other local accounts off it.
 */
export class VirtualDisplay {
    readonly authorityFile: string;
    private server: ChildProcess | undefined;
    private session: ChildProcess | undefined;
    private number: number | undefined;

    constructor(private readonly env: NodeJS.ProcessEnv, private readonly socketDirectory: string, stateDirectory = join(tmpdir(), `muxr-display-${process.getuid?.() ?? 'user'}`)) {
        this.authorityFile = join(stateDirectory, 'Xauthority');
        process.once('exit', () => this.stop());
    }

    installed(): boolean {
        return onPath(XVFB, this.env) !== undefined;
    }

    /** Started here and still running. */
    running(): boolean {
        return this.server !== undefined && this.server.exitCode === null && this.server.signalCode === null;
    }

    /** Forget a server of ours that died, with the socket it left behind. */
    reap(): void {
        if (this.server !== undefined && !this.running()) this.stop();
    }

    /** The display to use: this host's own, started now if it is not running. */
    async ensure(): Promise<string> {
        if (this.running() && this.number !== undefined) return `:${this.number}`;
        this.stop();
        const xvfb = onPath(XVFB, this.env);
        if (xvfb === undefined) throw new Error('Xvfb is not installed');
        const number = firstFreeDisplayNumber(this.socketDirectory, FIRST_NUMBER);
        mkdirSync(join(this.authorityFile, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(this.authorityFile, authorityEntry(number, randomBytes(16)), { mode: 0o600 });
        const server = spawn(xvfb, [`:${number}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-auth', this.authorityFile], { env: this.env, stdio: 'ignore' });
        this.server = server;
        this.number = number;
        try {
            await waitForDisplaySocket(this.socketDirectory, number, START_TIMEOUT_MS, () => this.running());
        } catch (error) {
            this.stop();
            throw error;
        }
        const desktop = onPath(SESSION, this.env);
        if (desktop !== undefined) {
            // Its own process group, so stopping it takes the whole session down.
            this.session = spawn(desktop, [], { env: { ...this.env, DISPLAY: `:${number}`, XAUTHORITY: this.authorityFile }, stdio: 'ignore', detached: true });
            this.session.unref();
        }
        return `:${number}`;
    }

    stop(): void {
        const session = this.session;
        this.session = undefined;
        if (session?.pid !== undefined && session.exitCode === null) {
            try { process.kill(-session.pid, 'SIGTERM'); } catch { /* already gone */ }
        }
        const server = this.server;
        this.server = undefined;
        if (server !== undefined && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
        if (this.number !== undefined && server !== undefined) removeDisplayFiles(this.socketDirectory, this.number);
        this.number = undefined;
    }
}

