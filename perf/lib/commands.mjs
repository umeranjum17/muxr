import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

let active;
const defaultRun = promisify(execFile);
export const useCommandScope = (scope) => { active = scope; };
export const runCommand = (...args) => active ? active.run(...args) : defaultRun(...args);
export const spawnCommand = (...args) => active ? active.spawn(...args) : nodeSpawn(...args);
export const onCommandCleanup = (cleanup) => active?.cleanups.push(cleanup);
export const commandSignal = () => active?.signal;
export const commandRemaining = (defaultMs = 30_000) => active?.remaining(defaultMs) ?? defaultMs;
export const assertCommandActive = () => active?.signal.throwIfAborted();
export const fetchCommand = (input, init = {}) => fetch(input, { ...init, signal: active?.signal ?? init.signal });

/** All gate subprocesses share cancellation, including helpers during setup. */
export class CommandScope {
    controller = new AbortController();
    children = new Map();
    cleanups = [];
    deadlineAt;
    deadlineTimer;
    get signal() { return this.controller.signal; }
    setDeadline(deadlineAt) {
        this.deadlineAt = deadlineAt;
        clearTimeout(this.deadlineTimer);
        this.deadlineTimer = setTimeout(() => this.abort(new Error('probe deadline exceeded')), Math.max(0, deadlineAt - Date.now()));
        if (deadlineAt <= Date.now()) this.abort(new Error('probe deadline exceeded'));
    }
    remaining(defaultMs = 30_000) {
        if (this.deadlineAt !== undefined && this.deadlineAt <= Date.now()) {
            this.abort(new Error('probe deadline exceeded'));
            this.signal.throwIfAborted();
        }
        return this.deadlineAt === undefined ? defaultMs : Math.max(1, Math.min(defaultMs, this.deadlineAt - Date.now()));
    }
    abort(reason = new Error('commands cancelled')) {
        clearTimeout(this.deadlineTimer);
        this.deadlineTimer = undefined;
        if (!this.signal.aborted) this.controller.abort(reason);
        for (const child of this.children.keys()) this.kill(child);
    }
    spawn(bin, args, options = {}) {
        this.signal.throwIfAborted();
        const child = nodeSpawn(bin, args, { ...options, detached: true });
        const closed = new Promise((done) => child.once('close', done));
        this.children.set(child, closed);
        // Always handle spawn errors, including callers waiting for readiness.
        child.on('error', () => {});
        child.once('close', () => this.children.delete(child));
        return child;
    }
    kill(child) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    async run(bin, args, options = {}) {
        this.signal.throwIfAborted();
        const { timeout = 30_000, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8', input, ...rest } = options;
        const boundedTimeout = this.remaining(timeout);
        const child = this.spawn(bin, args, { ...rest, stdio: ['pipe', 'pipe', 'pipe'] });
        if (input !== undefined) child.stdin.end(input); else child.stdin.end();
        return new Promise((resolve, reject) => {
            const stdout = [], stderr = [];
            let bytes = 0, error;
            const timer = setTimeout(() => { error = new Error(`${bin}: exceeded ${boundedTimeout}ms`); this.kill(child); }, boundedTimeout);
            const collect = (target) => (chunk) => {
                bytes += chunk.length;
                if (bytes > maxBuffer) { error = new Error(`${bin}: output exceeds ${maxBuffer} bytes`); this.kill(child); }
                else target.push(chunk);
            };
            child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
            child.once('error', (cause) => { error = cause; });
            child.once('close', (code) => {
                clearTimeout(timer);
                const decode = (chunks) => encoding === null || encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
                const result = { stdout: decode(stdout), stderr: decode(stderr) };
                if (this.signal.aborted || error || code !== 0) reject(Object.assign(error ?? new Error(`${bin}: ${this.signal.aborted ? 'cancelled' : `exit ${code}`}`), result));
                else resolve(result);
            });
        });
    }
    async close(timeoutMs = 10_000) {
        this.abort();
        const pending = [...this.children.entries()];
        for (const [child] of pending) this.kill(child);
        let timer;
        try {
            await Promise.race([
                Promise.all(pending.map(([, closed]) => closed)),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned commands did not terminate within the cleanup budget')), Math.max(1, timeoutMs)); }),
            ]);
        } finally { clearTimeout(timer); }
    }
    cleanup() { for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
}
