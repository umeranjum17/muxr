import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const XVFB = 'Xvfb';
/** A light desktop session to run on it, when the machine has one installed. */
const SESSION = 'startxfce4';
const FIRST_NUMBER = 90;
const START_TIMEOUT_MS = 5000;

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
    for (const directory of (env.PATH ?? '').split(':')) {
        if (directory === '') continue;
        const candidate = join(directory, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Not here.
        }
    }
    return undefined;
}

/** One MIT-MAGIC-COOKIE-1 entry for any host, in the Xauthority file format. */
function authorityEntry(number: number, cookie: Buffer): Buffer {
    const field = (value: Buffer) => {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(value.length);
        return Buffer.concat([length, value]);
    };
    const family = Buffer.alloc(2);
    family.writeUInt16BE(0xffff);
    return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(number))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

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
        let number = FIRST_NUMBER;
        while (existsSync(join(this.socketDirectory, `X${number}`)) || existsSync(`/tmp/.X${number}-lock`)) number += 1;
        mkdirSync(join(this.authorityFile, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(this.authorityFile, authorityEntry(number, randomBytes(16)), { mode: 0o600 });
        const server = spawn(xvfb, [`:${number}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-auth', this.authorityFile], { env: this.env, stdio: 'ignore' });
        this.server = server;
        this.number = number;
        const socket = join(this.socketDirectory, `X${number}`);
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (!this.isSocket(socket)) {
            if (!this.running() || Date.now() > deadline) {
                this.stop();
                throw new Error('the virtual screen did not start');
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
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
        // A server that was killed outright leaves its socket and lock behind,
        // and the next start must not mistake them for a live display.
        if (this.number !== undefined && server !== undefined) {
            rmSync(join(this.socketDirectory, `X${this.number}`), { force: true });
            rmSync(`/tmp/.X${this.number}-lock`, { force: true });
        }
        this.number = undefined;
    }

    private isSocket(path: string): boolean {
        try {
            return statSync(path).isSocket();
        } catch {
            return false;
        }
    }
}
