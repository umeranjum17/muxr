import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_CALL_KILL_GRACE_MS } from '@muxr/contract';

export class PluginApprovals {
    private values: Record<string, string> = {};
    private loaded = false;
    private writes = Promise.resolve();
    private inFlight = new Map<string, Set<{ promise: Promise<unknown>; controller: AbortController }>>();
    private revoking = new Set<string>();
    /**
     * Authority fence, owned here by the mutation itself: a monotonic
     * per-device revision that moves synchronously at the start of every
     * `set` -- before any load, drain, or persistence await -- and again
     * when it settles, plus the count of mutations in flight. A standing
     * check captures the revision before its own reads and compares it
     * synchronously before use; one that starts while a mutation is in
     * flight is denied outright. Readers therefore never treat approval
     * state observed across a mutation as current.
     */
    private revisions = new Map<string, number>();
    private mutating = new Map<string, number>();
    private listeners = new Set<(deviceId: string, pluginId: string) => void>();
    /**
     * One ordered mutation queue per (device, plugin): writes apply in
     * request order, an unchanged-value no-op is decided only inside the
     * queue after every earlier write settled, and the fence reads as in
     * flux from enqueue to settle -- a queued revoke is pending authority,
     * never a stale no-op, and can never be overtaken by an earlier enable.
     */
    private queues = new Map<string, Promise<void>>();
    private pending = new Map<string, number>();
    constructor(private readonly dataDir: string) {}

    /**
     * Synchronous authority revision, fenced per (device, plugin): undefined
     * while a mutation of exactly that pair is in flight. Without a plugin
     * the fence is device-wide -- any mutation for the device.
     */
    revision(deviceId: string, pluginId?: string): number | undefined {
        if (pluginId === undefined) {
            for (const [fence, count] of this.pending) {
                if (count > 0 && fence.startsWith(`${encodeURIComponent(deviceId)}:`)) return undefined;
            }
            let total = 0;
            for (const [fence, value] of this.revisions) {
                if (fence.startsWith(`${encodeURIComponent(deviceId)}:`)) total += value;
            }
            return total;
        }
        const fence = key(deviceId, pluginId);
        if ((this.pending.get(fence) ?? 0) > 0) return undefined;
        return this.revisions.get(fence) ?? 0;
    }

    /**
     * Synchronous mutation-start hook: called with the exact device and
     * plugin before any load, drain, or persistence of that mutation. The
     * consumer closes what stands on that approval right then; persistence
     * completion is irrelevant to forwarding.
     */
    onMutation(listener: (deviceId: string, pluginId: string) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private beginMutation(deviceId: string, pluginId: string): () => void {
        const fence = key(deviceId, pluginId);
        this.revisions.set(fence, (this.revisions.get(fence) ?? 0) + 1);
        this.mutating.set(fence, (this.mutating.get(fence) ?? 0) + 1);
        for (const listener of [...this.listeners]) {
            try {
                listener(deviceId, pluginId);
            } catch {
                /* a consumer's failure never blocks the mutation */
            }
        }
        return () => {
            this.mutating.set(fence, (this.mutating.get(fence) ?? 1) - 1);
            this.revisions.set(fence, (this.revisions.get(fence) ?? 0) + 1);
        };
    }

    async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const parsed: unknown = JSON.parse(await readFile(this.path(), 'utf8'));
            this.values = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
        } catch { this.values = {}; }
    }

    /** On unless this device explicitly disabled the plugin. Hash changes do not turn it off. */
    has(deviceId: string, pluginId: string): boolean {
        const stored = this.values[key(deviceId, pluginId)];
        if (stored === '') return false;
        return true;
    }

    /**
     * Run approved work outside the persistence queue, concurrent up to the
     * caller's semaphore. Revocation fences the device+plugin; the enabled
     * plugin remains default-on and hash-insensitive until explicitly disabled.
     */
    async whileApproved<T>(deviceId: string, pluginId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const fence = key(deviceId, pluginId);
        if (this.revoking.has(fence)) throw new Error('plugin is being revoked');
        if (!this.has(deviceId, pluginId)) throw new Error('plugin is not approved for this device');
        const controller = new AbortController();
        let promise: Promise<T>;
        try { promise = operation(controller.signal); }
        catch (error) { return Promise.reject(error); }
        const tracked = { promise: promise as Promise<unknown>, controller };
        let pending = this.inFlight.get(fence);
        if (pending === undefined) { pending = new Set(); this.inFlight.set(fence, pending); }
        pending.add(tracked);
        try {
            return await promise;
        } finally {
            pending.delete(tracked);
            if (pending.size === 0) this.inFlight.delete(fence);
        }
    }

    /**
     * Track a long-lived approved stream. The caller owns release() exactly once;
     * revoke aborts the signal and waits briefly for the release/close path.
     */
    async track(deviceId: string, pluginId: string, onAbort: () => void): Promise<{ signal: AbortSignal; release: () => void }> {
        const fence = key(deviceId, pluginId);
        if (this.revoking.has(fence)) throw new Error('plugin is being revoked');
        if (!this.has(deviceId, pluginId)) throw new Error('plugin is not approved for this device');
        const controller = new AbortController();
        let resolveClosed!: () => void;
        const promise = new Promise<void>((resolve) => { resolveClosed = resolve; });
        const tracked = { promise: promise as Promise<unknown>, controller };
        let pending = this.inFlight.get(fence);
        if (pending === undefined) { pending = new Set(); this.inFlight.set(fence, pending); }
        pending.add(tracked);
        let released = false;
        const release = (): void => {
            if (released) return;
            released = true;
            pending.delete(tracked);
            if (pending.size === 0) this.inFlight.delete(fence);
            resolveClosed();
        };
        controller.signal.addEventListener('abort', () => {
            try { onAbort(); } catch { /* release still happens when the stream reports closed */ }
        }, { once: true });
        return { signal: controller.signal, release };
    }

    set(deviceId: string, pluginId: string, approved: boolean): Promise<void> {
        const fence = key(deviceId, pluginId);
        // Pending from this moment: readers see the fence in flux until
        // this write -- and every write queued ahead of it -- has settled.
        this.pending.set(fence, (this.pending.get(fence) ?? 0) + 1);
        const apply = async (): Promise<void> => {
            try {
                if (!this.loaded) await this.load();
                // Decided here, after earlier writes on this pair settled:
                // an unchanged value is not a mutation and fires nothing.
                if (this.has(deviceId, pluginId) === approved && (approved || this.values[fence] === '')) return;
                // The mutation-start invalidation fires synchronously,
                // before the changing operation's first await.
                const settle = this.beginMutation(deviceId, pluginId);
                try {
                    await this.mutate(deviceId, pluginId, approved);
                } finally {
                    settle();
                }
            } finally {
                this.pending.set(fence, (this.pending.get(fence) ?? 1) - 1);
            }
        };
        // An idle pair applies synchronously (the hook fires in this very
        // call); a busy pair queues behind its earlier writes in order.
        const prior = this.queues.get(fence);
        const queued = prior === undefined ? apply() : prior.then(apply, apply);
        const tail = queued.catch(() => undefined).then(() => {
            if (this.queues.get(fence) === tail) this.queues.delete(fence);
        });
        this.queues.set(fence, tail);
        return queued;
    }

    private async mutate(deviceId: string, pluginId: string, approved: boolean): Promise<void> {
        if (!approved) {
            // Revoke this device+plugin regardless of its current manifest hash.
            // Mobile may be stale. The fence is raised synchronously so a
            // caller that starts work right after calling set() is blocked.
            const fence = key(deviceId, pluginId);
            this.revoking.add(fence);
            try {
                await this.load();
                const pending = [...(this.inFlight.get(fence) ?? [])];
                for (const tracked of pending) tracked.controller.abort();
                if (pending.length > 0) {
                    await Promise.race([
                        Promise.allSettled(pending.map(({ promise }) => promise)),
                        delay(PLUGIN_CALL_KILL_GRACE_MS + 1_000),
                    ]);
                }
                await this.run(async () => {
                    this.values[key(deviceId, pluginId)] = '';
                    await this.persist();
                });
            } finally {
                this.revoking.delete(fence);
            }
            return;
        }
        await this.load();
        await this.run(async () => {
            this.values[key(deviceId, pluginId)] = '1';
            await this.persist();
        });
    }

    private async persist(): Promise<void> {
        await mkdir(this.dataDir, { recursive: true });
        const temp = join(this.dataDir, `.extension-approvals.${randomUUID()}.tmp`);
        await writeFile(temp, JSON.stringify(this.values), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.path());
    }

    private run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writes.then(operation, operation);
        this.writes = result.then(() => undefined, () => undefined);
        return result;
    }

    private path(): string { return join(this.dataDir, 'extension-approvals.json'); }
}

function key(deviceId: string, pluginId: string): string {
    return `${encodeURIComponent(deviceId)}:${encodeURIComponent(pluginId)}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}
