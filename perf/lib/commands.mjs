import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

let active;
const defaultRun = promisify(execFile);
export const useCommandScope = (scope) => { active = scope; };
export const runCommand = (...args) => active ? active.run(...args) : defaultRun(...args);
export const spawnCommand = (...args) => active ? active.spawn(...args) : nodeSpawn(...args);
export const onCommandCleanup = (cleanup) => active?.cleanups.push(cleanup);
export const commandSignal = () => active?.signal;
export const assertCommandActive = () => active?.signal.throwIfAborted();

/** All gate subprocesses share cancellation, including helpers during setup. */
export class CommandScope {
    controller = new AbortController();
    children = new Map();
    cleanups = [];
    get signal() { return this.controller.signal; }
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
        const { timeout = 30_000, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8', ...rest } = options;
        const child = this.spawn(bin, args, { ...rest, stdio: ['ignore', 'pipe', 'pipe'] });
        return new Promise((resolve, reject) => {
            const stdout = [], stderr = [];
            let bytes = 0, error;
            const timer = setTimeout(() => { error = new Error(`${bin}: exceeded ${timeout}ms`); this.kill(child); }, timeout);
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
    async close() {
        this.controller.abort();
        const pending = [...this.children.entries()];
        for (const [child] of pending) this.kill(child);
        let timer;
        try {
            await Promise.race([
                Promise.all(pending.map(([, closed]) => closed)),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned commands did not terminate within 10s; retaining emulator lock')), 10_000); }),
            ]);
        } finally { clearTimeout(timer); }
    }
    cleanup() { for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
}
