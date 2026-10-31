/**
 * HerdrKit-backed transport adapter. HerdrKit owns the socket, the event
 * batch and the per-pane status watches; this class keeps the exact surface
 * the session source was written against (positional timeouts, a connected
 * flag, status-watch readiness) so every `client.call(m, p, t)` site rides
 * the kit without edits.
 *
 * The kit already opens the batch socket and one filtered status socket per
 * agent pane during its own bootstrap, and taps both through `onEvent`, so
 * this class opens none of its own.
 *
 * Adopt-mode spawns take the host PATH plus the identity vars Herdr reads
 * through the kit's env/path options; the socket path needs no env because
 * `bin` is spawned with it directly.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HerdrKit } from '@byokit/herdr';
import { HERDR_OUTDATED } from '../../../../../scripts/setup/infrastructure/herdr.mjs';

/** The only shape the session source needs from a socket caller. */
export interface HerdrCaller {
    call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

/**
 * HERDR_SESSION marks a lab host: it serves that named session or refuses to
 * start. Herdr picks a session by socket, never by this env, so a host given
 * only the name used to fall back to the live default socket. The socket comes
 * from Herdr's own session list, and a HERDR_SOCKET_PATH naming any other
 * session (every Herdr pane exports the default one) is refused, not trusted.
 */
export async function labHerdrSocket(bin: string, socketPath: string | undefined): Promise<string | undefined> {
    const session = process.env.HERDR_SESSION?.trim();
    if (!session) return socketPath;
    const { stdout } = await promisify(execFile)(bin, ['session', 'list', '--json'], { timeout: 10_000 });
    const sessions = (JSON.parse(stdout) as { sessions?: Array<{ name: string; default: boolean; running: boolean; socket_path: string }> }).sessions ?? [];
    const named = sessions.find((entry) => entry.name === session);
    if (named?.default === true) throw new Error(`HERDR_SESSION=${session} is the live default Herdr session; a lab host needs its own named session (herdr --session <lab>).`);
    if (named?.running !== true) throw new Error(`HERDR_SESSION=${session} is not a running Herdr session; start it with \`herdr --session ${session}\` or unset HERDR_SESSION.`);
    if (socketPath !== undefined && resolve(socketPath) !== resolve(named.socket_path)) {
        const owner = sessions.find((entry) => resolve(entry.socket_path) === resolve(socketPath))?.name;
        throw new Error(`HERDR_SOCKET_PATH=${socketPath} is ${owner === undefined ? 'not a Herdr session socket' : `Herdr session "${owner}"`}, not lab session "${session}"; unset HERDR_SOCKET_PATH or set it to ${named.socket_path}.`);
    }
    return named.socket_path;
}

/**
 * One sample of a slow read, not a verdict. Every Herdr request and every
 * per-pane status acknowledgement gets 15 s of its own, and a refresh asked for
 * while another bootstrap runs waits for a follow-up that pays the status
 * barrier again, so a read that is still making progress on a loaded machine
 * overruns 20 s routinely. Measured on a loaded host (1-min load 32-47, 106
 * panes, 55 agent panes): a healthy read costs 0.1-0.5 s, of which the Herdr read
 * itself is ~105 ms and the tree build 0.5 ms -- the rest is time spent waiting
 * on Herdr. Restarting the kit on a single sample threw away a read that was
 * about to land, so the wait is sampled and the kit is restarted only once the
 * read has stayed over the line for every sample in a row.
 */
const REFRESH_SLOW_MS = 20_000;
/** Consecutive slow samples before a read counts as wedged: 60 s, well past the
 * kit's own 15 s request and 15 s acknowledgement deadlines. */
const REFRESH_WEDGED_SAMPLES = 3;

export class KitHerdrClient implements HerdrCaller {
    /** Live event-socket state, surfaced on `herdr.tree` so the phone can tell a dead herdr from a quiet one. */
    connected = false;
    /** The running Herdr server speaks an older protocol than muxr: the binary may already be updated while the old server keeps running. */
    outdated = false;
    readonly kit: HerdrKit;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private closed = false;
    /** Edge trigger: log the first reconnect failure and the recovery, never every retry. */
    private down = false;
    private outage = false;
    /** Timestamp for the active kit-reported stall, used for the recovery journal line. */
    private stalledSince: number | undefined;
    private restarting: Promise<void> | undefined;
    private observedReadiness: Promise<void> | undefined;
    private readonly stopBootstrapWatch: () => void;

    constructor(
        resolveBin: () => string,
        private readonly socketPath: string,
        private readonly onReconnect: () => void,
    ) {
        // Adopt-mode spawns (CLI, terminal) need the host's PATH (mise shims,
        // hostedtoolcache) plus the identity vars Herdr itself reads. The kit
        // merges `env` over its fixed adopt base and joins `path` for PATH.
        const kitEnv: Record<string, string> = {
            HOME: homedir(),
            ...(process.env.HERDR_CLIENT_SOCKET_PATH === undefined
                ? {}
                : { HERDR_CLIENT_SOCKET_PATH: process.env.HERDR_CLIENT_SOCKET_PATH }),
            ...(process.env.HERDR_SESSION === undefined ? {} : { HERDR_SESSION: process.env.HERDR_SESSION }),
        };
        const kit = new HerdrKit({
            mode: 'adopt',
            get bin() { return resolveBin(); },
            socketPath,
            env: kitEnv,
            path: (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== ''),
            onState: (state) => {
                const ready = state.phase === 'ready';
                const wasReady = this.connected;
                if (state.phase === 'stalled' && wasReady) {
                    this.stalledSince = Date.now();
                    process.stderr.write('herdr: not answering (2 calls timed out)\n');
                }
                if (ready && this.stalledSince !== undefined) {
                    process.stderr.write(`herdr: answering again after ${Math.round((Date.now() - this.stalledSince) / 1000)}s\n`);
                    this.stalledSince = undefined;
                }
                this.connected = ready;
                if (ready) this.observeBootstrap();
                if (!ready && wasReady) this.outage = true;
                if (ready && !wasReady) this.recover();
            },
        });
        this.kit = new Proxy(kit, {
            get: (target, key) => {
                const value: unknown = Reflect.get(target, key, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => value.apply(target, args);
            },
        });
        // onEvent precedes the kit's event-triggered bootstrap. Inspect its
        // public readiness promise after that synchronous dispatch, without a
        // second onChange subscriber (which would clone every whole tree).
        const observeBootstrap = () => this.observeBootstrap();
        this.stopBootstrapWatch = kit.onEvent(() => queueMicrotask(observeBootstrap));
    }

    /** Only a down server is worth retrying: a version mismatch or a rejected
     * subscription fails closed with its message instead of stacking attempts. */
    private static isDownError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /socket unavailable|socket closed|request timed out|ECONNREFUSED|ENOENT|EACCES|connect E|not connected/i.test(message);
    }

    private static isOutdatedError(error: unknown): boolean {
        return /protocol mismatch/.test(error instanceof Error ? error.message : String(error));
    }

    /**
     * One kit start. The kit already pings with its own backoff, which absorbs
     * the host and herdr booting together; a second backoff here would keep the
     * host off the link while herdr is down.
     */
    async start(): Promise<void> {
        try {
            await this.kit.start();
            this.connected = true;
        } catch (cause) {
            // An old server stays up until someone restarts it, so keep checking and clear once it answers current.
            if (KitHerdrClient.isOutdatedError(cause)) {
                this.outdated = true;
                this.down = true;
                this.outage = true;
                this.scheduleReconnect();
                throw new Error(HERDR_OUTDATED, { cause });
            }
            if (!KitHerdrClient.isDownError(cause)) throw cause;
            // Staying up matters more than starting clean: the reconnect loop keeps
            // retrying and onReconnect resubscribes when herdr comes back.
            this.down = true;
            this.outage = true;
            this.scheduleReconnect();
            throw cause;
        }
    }

    /** One request, one connection. The server closes after answering. */
    /**
     * `timeoutMs` overrides the default for methods that block server-side --
     * `agent.wait` can legitimately sit for the length of an agent's turn.
     */
    async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        if (this.closed) throw new Error('herdr: client closed');
        return await this.kit.call(
            method as never,
            params as never,
            timeoutMs === undefined ? undefined : { timeoutMs },
        ) as T;
    }

    /** Guard automatic bootstraps too: passive consumers no longer refresh. */
    private observeBootstrap(): void {
        if (this.closed) return;
        const ready = this.kit.statusWatchReady();
        if (ready === this.observedReadiness) return;
        this.observedReadiness = ready;
        void this.guardRefresh(ready).catch((cause: unknown) => {
            if (!this.closed) process.stderr.write(`herdr: bootstrap recovery failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        });
    }

    /**
     * The full tree read mutations still wait on. @byokit/herdr 0.16 never
     * settles a status watch Herdr refuses for a pane that closed as the watch
     * opened (the refusal carries `<id>:sub:0:probe`), so that refresh, and every
     * one queued behind it, waited for good: lists and Usage still answered while
     * no pane would open until the host restarted. A read that stays wedged
     * across every slow sample restarts the kit the way an outage does: stop
     * rejects the stuck readers, start reads the tree fresh.
     */
    async refresh(): Promise<void> {
        await this.guardRefresh(this.kit.refresh());
    }

    private async guardRefresh(read: Promise<void>): Promise<void> {
        const settled = read.then(() => true);
        for (let sample = 1; ; sample += 1) {
            let timer: NodeJS.Timeout | undefined;
            const overrun = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), REFRESH_SLOW_MS); });
            const landed = await Promise.race([settled, overrun]).finally(() => clearTimeout(timer));
            if (landed) return;
            const waited = (sample * REFRESH_SLOW_MS) / 1000;
            if (sample < REFRESH_WEDGED_SAMPLES) {
                process.stderr.write(`herdr: tree read still waiting after ${waited}s (slow sample ${sample}/${REFRESH_WEDGED_SAMPLES}); keeping the herdr kit\n`);
                continue;
            }
            process.stderr.write(`herdr: tree read still waiting after ${waited}s (${sample} slow samples in a row); restarting the herdr kit\n`);
            break;
        }
        this.restarting ??= this.restartKit().finally(() => { this.restarting = undefined; });
        await this.restarting;
        await this.kit.refresh();
    }

    private async restartKit(): Promise<void> {
        this.connected = false;
        this.outage = true;
        await this.kit.stop();
        if (this.closed) return;
        await this.start();
        this.recover();
    }

    async close(): Promise<void> {
        this.closed = true;
        this.connected = false;
        if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
        this.stopBootstrapWatch();
        await this.kit.stop().catch(() => {});
    }

    private recover(): void {
        if (!this.outage) return;
        this.outage = false;
        this.onReconnect();
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer !== undefined) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.closed) return;
            void this.kit.start()
                .then(() => {
                    if (this.down) {
                        this.down = false;
                        process.stderr.write(`herdr server reachable again at ${this.socketPath}\n`);
                    }
                    this.connected = true;
                    this.outdated = false;
                    this.recover();
                })
                .catch((cause: unknown) => {
                    const outdated = KitHerdrClient.isOutdatedError(cause);
                    if (!this.down || outdated !== this.outdated) {
                        this.down = true;
                        process.stderr.write(`${outdated ? HERDR_OUTDATED : cause instanceof Error ? cause.message : String(cause)}\n`);
                    }
                    this.outdated = outdated;
                    this.scheduleReconnect();
                });
        }, 1000);
    }
}
