import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { PluginsInvalidatedFrame, PluginContextRequest, PluginManifestV1, PluginRpcMode, PluginSource, PluginSummary } from '@muxr/contract';
import {
    MAX_RPC_STDERR_BYTES,
    MAX_RPC_STDOUT_BYTES,
    PLUGIN_CALL_DEADLINE_MS,
    PLUGIN_CALL_KILL_GRACE_MS,
    boundRpcDisplay,
    isValidPluginId,
    parseManifest,
    sanitizeDisplayText,
} from '@muxr/contract';

const MANIFEST_NAME = 'muxr-ui.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TEXT = 200;
export type HerdrPlugin = {
    plugin_id: string;
    name: string;
    version: string;
    description?: string | null;
    plugin_root: string;
    enabled: boolean;
    build?: unknown[];
    startup?: unknown[];
    actions?: ({ id: string; command?: string[] } & Record<string, unknown>)[];
    events?: unknown[];
    panes?: unknown[];
    link_handlers?: unknown[];
    source?: { kind?: string | null; owner?: string | null; repo?: string | null; subdir?: string | null; resolved_commit?: string | null } | null;
    warnings?: (string | null)[];
};

type PluginCall = { method: string; entry: string; mode: PluginRpcMode; modeDeclared: boolean; context?: PluginContextRequest[] };
type PluginStream = { entry: string };
type Snapshot = { pluginRoot: string; manifest: PluginManifestV1; summary: Omit<PluginSummary, 'approved'>; actions: Map<string, string>; calls: Map<string, PluginCall>; streams: Map<string, PluginStream> };
type ParsedProjection = { pluginRoot: string; manifest: PluginManifestV1; canonical: string };

export type PluginDigestSnapshot = {
    digests: ReadonlyMap<string, string>;
    enabled: ReadonlyMap<string, boolean>;
};

/** Single-flight poll gate with one trailing read for freshness-critical callers. */
export class PluginRefreshGate {
    private current: Promise<void> | undefined;
    private trailing: Promise<void> | undefined;

    constructor(private readonly refresh: () => Promise<void>) {}

    poll(): Promise<void> { return this.start(); }

    forceFresh(): Promise<void> {
        if (this.current === undefined) return this.start();
        if (this.trailing !== undefined) return this.trailing;
        const current = this.current;
        const startTrailing = () => {
            this.trailing = undefined;
            return this.start();
        };
        this.trailing = current.then(startTrailing, startTrailing);
        return this.trailing;
    }

    private start(): Promise<void> {
        if (this.current !== undefined) return this.current;
        const run = this.refresh();
        const settled = run.finally(() => { if (this.current === settled) this.current = undefined; });
        this.current = settled;
        return settled;
    }
}

/** Compare two authoritative snapshots; omitted IDs are informational only. */
export function pluginInvalidationFrame(previous: PluginDigestSnapshot, next: PluginDigestSnapshot): PluginsInvalidatedFrame | undefined {
    const changed = [...new Set([...previous.digests.keys(), ...next.digests.keys()])]
        .filter((id) => previous.digests.get(id) !== next.digests.get(id));
    if (changed.length === 0) return undefined;
    // Empty is the existing full-invalidation sentinel. Never send a partial
    // list: mobile treats a non-empty list as exhaustive.
    const valid = changed.filter(isValidPluginId);
    const pluginIds = changed.length > 32 || valid.length !== changed.length ? [] : valid.sort();
    const reasons = new Set(changed.map((id) => {
        const before = previous.digests.has(id);
        const after = next.digests.has(id);
        if (!before && after) return 'linked' as const;
        if (before && !after) return 'unlinked' as const;
        const wasEnabled = previous.enabled.get(id);
        const isEnabled = next.enabled.get(id);
        if (wasEnabled !== isEnabled) return isEnabled === true ? 'enabled' as const : 'disabled' as const;
        return 'changed' as const;
    }));
    return { type: 'plugins.invalidated', reason: reasons.size === 1 ? [...reasons][0]! : 'changed', pluginIds };
}

export class PluginCatalog {
    private snapshots = new Map<string, Snapshot>();
    private active = new Map<string, string>();
    private installed = new Map<string, { snapshot: Snapshot; enabled: boolean }>();
    private parsedProjections = new Map<string, ParsedProjection>();

    /** Refresh from authoritative plugin.list and return stable per-plugin digests. */
    async refresh(plugins: HerdrPlugin[]): Promise<Map<string, string>> {
        const active = new Map<string, string>();
        const snapshots = new Map<string, Snapshot>();
        const installed = new Map<string, { snapshot: Snapshot; enabled: boolean }>();
        const digests = new Map<string, string>();
        const usedProjectionKeys = new Set<string>();
        for (const plugin of plugins) {
            // Disabled manifests stay inert, but parsing their cached projection
            // lets generic capability pickers show installed alternatives.
            const loaded = await loadPlugin(plugin, this.parsedProjections, usedProjectionKeys).catch((error) => backendOnly(
                plugin,
                `muxr UI rejected: ${error instanceof Error ? error.message : String(error)}`,
            ));
            const summary = loaded.summary;
            digests.set(plugin.plugin_id, digest(stableJson({
                pluginId: plugin.plugin_id,
                name: summary.name,
                description: summary.description ?? null,
                version: summary.version,
                enabled: plugin.enabled,
                root: plugin.plugin_root,
                source: summary.source,
                authority: {
                    build: plugin.build ?? [], startup: plugin.startup ?? [], actions: plugin.actions ?? [],
                    events: plugin.events ?? [], panes: plugin.panes ?? [], links: plugin.link_handlers ?? [],
                },
                warnings: summary.warnings,
                manifestHash: summary.manifestHash ?? null,
            })));
            installed.set(plugin.plugin_id, { snapshot: loaded, enabled: plugin.enabled });
            if (!plugin.enabled) continue;
            snapshots.set(plugin.plugin_id, loaded);
            active.set(plugin.plugin_id, loaded.summary.manifestHash ?? '');
        }
        for (const key of this.parsedProjections.keys()) {
            if (!usedProjectionKeys.has(key)) this.parsedProjections.delete(key);
        }
        this.snapshots = snapshots;
        this.active = active;
        this.installed = installed;
        return digests;
    }

    capabilityPlugins(capability: string): Array<{ pluginId: string; name: string; enabled: boolean; source: PluginSource; hasBackend: boolean }> {
        return [...this.installed].flatMap(([pluginId, { snapshot, enabled }]) =>
            snapshot.manifest.capabilities?.[capability] === undefined
                ? []
                : [{
                    pluginId,
                    name: snapshot.summary.name,
                    enabled,
                    source: snapshot.summary.source,
                    hasBackend: snapshot.summary.hasBackend,
                }],
        ).sort((left, right) => left.name.localeCompare(right.name));
    }

    list(isApproved: (pluginId: string, hash: string) => boolean): PluginSummary[] {
        return [...this.active]
            .map(([pluginId, hash]) => {
                const summary = this.snapshots.get(pluginId)!.summary;
                return { ...summary, approved: hash !== '' && isApproved(pluginId, hash) };
            })
            .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    }

    manifest(pluginId: string, manifestHash: string): PluginManifestV1 {
        this.assertActive(pluginId, manifestHash);
        return this.snapshots.get(pluginId)!.manifest;
    }

    action(pluginId: string, manifestHash: string, contributionId: string): string {
        this.assertActive(pluginId, manifestHash);
        const actionId = this.snapshots.get(pluginId)!.actions.get(contributionId);
        if (actionId === undefined) throw new Error('plugin action unavailable or changed');
        return actionId;
    }

    call(pluginId: string, manifestHash: string, contributionId: string): PluginCall {
        const { method, entry, mode, modeDeclared, context } = this.callTarget(pluginId, manifestHash, contributionId);
        return { method, entry, mode, modeDeclared, ...(context === undefined ? {} : { context }) };
    }

    /** Return the validated call and plugin root from one active catalog snapshot. */
    callTarget(pluginId: string, manifestHash: string, contributionId: string): PluginCall & { pluginRoot: string } {
        this.assertActive(pluginId, manifestHash);
        const snapshot = this.snapshots.get(pluginId)!;
        const call = snapshot.calls.get(contributionId);
        if (call === undefined) throw new Error('plugin call unavailable or changed');
        return { ...call, pluginRoot: snapshot.pluginRoot };
    }

    /** Return the validated stream contribution and plugin root from one active catalog snapshot. */
    streamTarget(pluginId: string, manifestHash: string, contributionId: string): PluginStream & { pluginRoot: string } {
        this.assertActive(pluginId, manifestHash);
        const snapshot = this.snapshots.get(pluginId)!;
        const stream = snapshot.streams.get(contributionId);
        if (stream === undefined) throw new Error('plugin stream unavailable or changed');
        return { ...stream, pluginRoot: snapshot.pluginRoot };
    }

    streamClaimsCapability(pluginId: string, manifestHash: string, contributionId: string, capability: string): boolean {
        this.assertActive(pluginId, manifestHash);
        return this.snapshots.get(pluginId)!.manifest.capabilities?.[capability] === contributionId;
    }

    private assertActive(pluginId: string, manifestHash: string): void {
        if (manifestHash === '' || this.active.get(pluginId) !== manifestHash || !this.snapshots.has(pluginId)) {
            throw new Error('plugin manifest unavailable or changed');
        }
    }
}

async function loadPlugin(
    plugin: HerdrPlugin,
    cache: Map<string, ParsedProjection>,
    usedKeys: Set<string>,
): Promise<Snapshot> {
    const pluginRoot = realpathSync(plugin.plugin_root);
    const path = join(pluginRoot, MANIFEST_NAME);
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return backendOnly(plugin, undefined, pluginRoot);
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('invalid muxr plugin manifest file');
        const projectionKey = `${pluginRoot}\0${stat.dev}:${stat.ino}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.size}`;
        usedKeys.add(projectionKey);
        let projection = cache.get(projectionKey);
        if (projection === undefined) {
            const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_MANIFEST_BYTES) throw new Error('muxr plugin manifest is too large');
            const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
            const manifest = parseManifest(parsed);
            projection = { pluginRoot, manifest, canonical: stableJson(parsed) };
            cache.set(projectionKey, projection);
        }
        const { manifest, canonical } = projection;
        if (manifest.pluginId !== plugin.plugin_id) throw new Error('plugin id must match Herdr plugin id');
        const declaredActions = plugin.actions ?? [];
        const actionCommands = new Map<string, string[]>();
        for (const action of declaredActions) {
            if (actionCommands.has(action.id)) throw new Error(`duplicate Herdr action: ${action.id}`);
            if (action.command !== undefined && (!Array.isArray(action.command) || action.command.some((part) => typeof part !== 'string'))) throw new Error(`invalid Herdr action command: ${action.id}`);
            actionCommands.set(action.id, action.command ?? []);
        }
        const actions = new Map<string, string>();
        const calls = new Map<string, PluginCall>();
        const streams = new Map<string, PluginStream>();
        for (const contribution of manifest.contributions) {
            if (contribution.slot === 'session.toolbar' && contribution.type === 'button') {
                const actionId = contribution.action.actionId;
                if (!actionCommands.has(actionId)) throw new Error(`plugin action is not declared by Herdr: ${actionId}`);
                actions.set(contribution.id, actionId);
            } else if (contribution.slot === 'host.stream') {
                streams.set(contribution.id, { entry: contribution.entry });
            } else if (contribution.slot === 'host.rpc') {
                calls.set(contribution.id, {
                    method: contribution.method,
                    entry: contribution.entry,
                    mode: contribution.mode,
                    modeDeclared: contribution.modeDeclared === true,
                    ...(contribution.context === undefined ? {} : { context: contribution.context }),
                });
            }
        }
        // Cross-reference checks (data cards must be read mode, screen RPCs,
        // navigation targets, capabilities, duplicate ids) live in the shared
        // parseManifest from @muxr/contract, so the CLI validates identically.
        // The approval hash binds the complete parsed raw manifest object --
        // including fields this host does not understand -- so ignored future
        // fields still rotate trust when they change. It deliberately excludes
        // name, description and version: those grant no authority, and hashing
        // them meant a typo fix or a version bump silently disabled the plugin
        // on every paired device. Plugin code is not hashed either, so version
        // never protected against a changed rpc.mjs -- installing through Herdr
        // is what gates that.
        const authorityInput = {
            build: plugin.build ?? [], startup: plugin.startup ?? [],
            // Bind the complete Herdr action object, including contexts,
            // platforms, and additive fields unknown to this host version.
            actions: [...declaredActions].sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
            events: plugin.events ?? [], panes: plugin.panes ?? [], links: plugin.link_handlers ?? [],
        };
        assertFiniteNumbers(authorityInput);
        const authority = stableJson(authorityInput);
        const source = sourceOf(plugin.source, plugin, pluginRoot);
        const manifestHash = digest(`${APPROVAL_DOMAIN}\0${plugin.plugin_id}\0${sourceIdentity(source, pluginRoot)}\0${authority}\0${canonical}`);
        return { pluginRoot, manifest, actions, calls, streams, summary: summaryOf(plugin, manifestHash, manifest.capabilities ?? {}, source, manifest) };
    } finally {
        await handle.close();
    }
}

function backendOnly(plugin: HerdrPlugin, warning?: string, pluginRoot = plugin.plugin_root): Snapshot {
    const summary = summaryOf(plugin, undefined, {});
    return {
        pluginRoot,
        manifest: { schemaVersion: 1, pluginId: plugin.plugin_id, contributions: [] },
        actions: new Map(),
        calls: new Map(),
        streams: new Map(),
        summary: warning === undefined ? summary : { ...summary, warnings: [warning, ...summary.warnings].slice(0, 4) },
    };
}

function summaryOf(plugin: HerdrPlugin, manifestHash: string | undefined, capabilities: Record<string, string>, source = sourceOf(plugin.source, plugin), manifest?: PluginManifestV1): Omit<PluginSummary, 'approved'> {
    return {
        pluginId: plugin.plugin_id,
        name: safeText(plugin.name, 80)[0] ?? plugin.plugin_id,
        version: safeText(plugin.version, 40)[0] ?? '0.0.0',
        ...(typeof plugin.description === 'string' ? { description: text(plugin.description, MAX_TEXT) } : {}),
        source,
        ...(manifestHash === undefined ? {} : { manifestHash }),
        capabilities,
        hasBackend: [plugin.build, plugin.startup, plugin.actions, plugin.events, plugin.panes, plugin.link_handlers].some((value) => (value?.length ?? 0) > 0)
            || manifest?.contributions.some((item) => item.slot === 'host.rpc' || item.slot === 'host.stream') === true,
        warnings: (plugin.warnings ?? []).filter((warning): warning is string => typeof warning === 'string').slice(0, 4).flatMap((warning) => safeText(warning, MAX_TEXT)),
    };
}

function sourceOf(source: HerdrPlugin['source'], plugin?: HerdrPlugin, pluginRoot?: string): PluginSource {
    if (source?.kind !== 'github') {
        const npm = plugin === undefined ? undefined : npmProvenance(plugin, pluginRoot);
        return npm ?? { kind: 'local' };
    }
    return {
        kind: 'github',
        ...(typeof source.owner === 'string' ? { owner: text(source.owner, 100) } : {}),
        ...(typeof source.repo === 'string' ? { repo: text(source.repo, 100) } : {}),
        ...(typeof source.subdir === 'string' ? { subdir: text(source.subdir, 160) } : {}),
        ...(typeof source.resolved_commit === 'string' ? { resolvedCommit: text(source.resolved_commit, 80) } : {}),
    };
}
function sourceIdentity(source: PluginSource, pluginRoot: string): string {
    // Summaries intentionally omit filesystem paths, but approval must bind
    // the canonical executable root for every source kind.
    return stableJson({ source, root: pluginRoot });
}

type NpmProvenance = { schemaVersion: 1; pluginId: string; root: string; name: string; version: string; integrity: string };
function npmProvenance(plugin: HerdrPlugin, pluginRoot?: string): PluginSource | undefined {
    let root;
    try { root = pluginRoot ?? realpathSync(plugin.plugin_root); } catch { return undefined; }
    const expectedRootPath = resolve(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'extensions');
    let expectedRoot: string;
    try {
        const extensionStat = lstatSync(expectedRootPath);
        if (extensionStat.isSymbolicLink() || !extensionStat.isDirectory()) return undefined;
        const provenanceStat = lstatSync(join(expectedRootPath, '.provenance'));
        if (provenanceStat.isSymbolicLink() || !provenanceStat.isDirectory()) return undefined;
        expectedRoot = realpathSync(expectedRootPath);
    } catch { return undefined; }
    const rel = relative(expectedRoot, root);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes('\\') || rel.split(/[\\/]/).length !== 1 || rel !== plugin.plugin_id) return undefined;
    const metadata = join(expectedRoot, '.provenance', `${plugin.plugin_id}.json`);
    try {
        const metadataStat = lstatSync(metadata);
        if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > 8192) return undefined;
        const fd = openSync(metadata, constants.O_RDONLY | constants.O_NOFOLLOW);
        let raw;
        try { raw = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
        const parsed = JSON.parse(raw) as Partial<NpmProvenance>;
        if (parsed.schemaVersion !== 1 || parsed.pluginId !== plugin.plugin_id || parsed.root !== root
            || typeof parsed.name !== 'string' || !/^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$|^[A-Za-z0-9._-]+$/.test(parsed.name)
            || typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parsed.version)
            || typeof parsed.integrity !== 'string' || parsed.name.length > 200 || parsed.version.length > 80 || parsed.integrity.length > 200 || !/^(?:sha256|sha512)-[A-Za-z0-9+/=]+$/.test(parsed.integrity)) return undefined;
        return { kind: 'npm', name: text(parsed.name, 200), version: text(parsed.version, 80), integrity: text(parsed.integrity, 200) };
    } catch { return undefined; }
}
function assertFiniteNumbers(value: unknown): void {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('invalid Herdr plugin authority number');
        return;
    }
    if (Array.isArray(value)) {
        for (const entry of value) assertFiniteNumbers(entry);
        return;
    }
    if (isRecord(value)) {
        for (const entry of Object.values(value)) assertFiniteNumbers(entry);
    }
}
function stableJson(value: unknown): string {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        // JSON.stringify turns every non-finite number into null; retain its
        // type and value so malformed registry data cannot collide with null.
        const kind = Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
        return `{"$muxrNonFiniteNumber":${JSON.stringify(kind)}}`;
    }
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
/**
 * Never change this string. It is a domain separator, not a version marker:
 * changing it rotates every hash and silently revokes consent on every paired
 * device. A product rename once did exactly that.
 */
const APPROVAL_DOMAIN = 'muxr-plugin-approval-v1';

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): string {
    if (typeof value !== 'string') throw new Error('invalid plugin text');
    const clean = sanitizeDisplayText(value).replace(/[\0-\x1F\x7F]/g, '').trim();
    if (clean.length === 0 || clean.length > max) throw new Error('invalid plugin text length');
    return clean;
}
function safeText(value: string, max: number): string[] {
    try { return [text(value, max)]; }
    catch { return []; }
}


export interface RunPluginProcessOptions {
    pluginId: string;
    method: string;
    script: string;
    serializedInput: string;
    stateDir: string;
    publicContext?: string;
    deadlineMs?: number;
    killGraceMs?: number;
    signal?: AbortSignal;
}

/** Run one bounded plugin process and escape even when descendants retain stdio. */
export function runPluginProcess(options: RunPluginProcessOptions): Promise<unknown> {
    const deadlineMs = options.deadlineMs ?? PLUGIN_CALL_DEADLINE_MS;
    const killGraceMs = options.killGraceMs ?? PLUGIN_CALL_KILL_GRACE_MS;
    if (options.signal?.aborted === true) return Promise.reject(pluginProcessError('AbortError', 'plugin call revoked'));
    return new Promise((resolve, reject) => {
        // ponytail: process-group termination is POSIX-only; Windows kills the direct child.
        const processGroup = process.platform !== 'win32';
        const child = spawn(process.execPath, [options.script, options.method], {
            cwd: process.cwd(),
            detached: processGroup,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                ...(process.env.MUXR_HOME ? { MUXR_HOME: process.env.MUXR_HOME } : {}),
                ...(options.publicContext === undefined ? {} : { MUXR_PLUGIN_CONTEXT_JSON: options.publicContext }),
                MUXR_PLUGIN_ID: options.pluginId,
                MUXR_PLUGIN_STATE_DIR: options.stateDir,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Caller input can contain secure-prompt values. stdin is private to this
        // child; unlike the environment it is not readable from /proc/<pid>/environ.
        child.stdin.on('error', () => { /* child may close stdin before reading */ });
        child.stdin.end(options.serializedInput);
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let stdoutOversize = false;
        let settled = false;
        let terminating = false;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;

        const signalProcess = (signal: NodeJS.Signals): void => {
            try {
                if (child.pid === undefined) return;
                if (processGroup) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch { /* process already exited */ }
        };
        const cleanup = (): void => {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            action();
        };
        const terminate = (error: Error): void => {
            if (settled) return;
            terminating = true;
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            signalProcess('SIGTERM');
            escalationTimer = setTimeout(() => signalProcess('SIGKILL'), killGraceMs);
            escalationTimer.unref();
            finish(() => reject(error));
        };
        const onAbort = (): void => terminate(pluginProcessError('AbortError', 'plugin call revoked'));

        child.stdout.on('data', (chunk: Buffer) => {
            if (stdoutOversize) return;
            stdout = Buffer.concat([stdout, chunk]);
            if (stdout.length > MAX_RPC_STDOUT_BYTES) { stdoutOversize = true; stdout = Buffer.alloc(0); }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = Buffer.concat([stderr, chunk]);
            if (stderr.length > MAX_RPC_STDERR_BYTES) stderr = stderr.subarray(stderr.length - MAX_RPC_STDERR_BYTES);
        });
        child.once('error', () => {
            if (escalationTimer !== undefined) { clearTimeout(escalationTimer); escalationTimer = undefined; }
            finish(() => reject(new Error(pluginStderrMessage(stderr, 'plugin call failed'))));
        });
        child.once('close', (code) => {
            if (escalationTimer !== undefined) {
                // The leader may exit on SIGTERM while descendants keep its process
                // group alive. Kill that still-owned group before canceling the
                // timer; do not leave a delayed signal that could hit a reused pgid.
                if (terminating && processGroup) signalProcess('SIGKILL');
                clearTimeout(escalationTimer);
                escalationTimer = undefined;
            }
            finish(() => {
                if (stdoutOversize) { reject(new Error(`plugin ${options.pluginId}.${options.method} output exceeded ${MAX_RPC_STDOUT_BYTES} bytes`)); return; }
                if (code !== 0) {
                    reject(new Error(pluginStderrMessage(stderr, `plugin exited with code ${code}`)));
                    return;
                }
                try { resolve(boundRpcDisplay(JSON.parse(stdout.toString('utf8')))); }
                catch { reject(new Error(`plugin ${options.pluginId}.${options.method} returned invalid JSON`)); }
            });
        });
        deadlineTimer = setTimeout(() => terminate(pluginProcessError(
            'PluginCallDeadlineError',
            `plugin ${options.pluginId}.${options.method} exceeded ${deadlineMs}ms`,
        )), deadlineMs);
        deadlineTimer.unref();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted === true) onAbort();
    });
}

function pluginStderrMessage(stderr: Buffer, fallback: string): string {
    const text = stderr.toString('utf8').trim();
    if (text === '') return fallback;
    // A plugin that crashes with an uncaught exception prints a code frame and
    // a stack with local install paths. The phone must see one clean message,
    // never the host's filesystem. Prefer the exception's own message line.
    const exceptionLine = text.split('\n').map((line) => line.trim()).find((line) => /^(?:[A-Za-z]+Error|Error): /.test(line));
    const message = (exceptionLine ?? text.split('\n')[0] ?? fallback).replace(/file:\/\/\S+/g, 'plugin').trim();
    return message.slice(0, 300) || fallback;
}

function pluginProcessError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

/** Write-call replay fence key: call identity plus the idempotency key (input excluded). */
export function rpcReplayKey(deviceId: string, pluginId: string, manifestHash: string, contributionId: string, idempotencyKey: string): string {
    return `${deviceId}\0${pluginId}\0${manifestHash}\0${contributionId}\0${idempotencyKey}`;
}

/** Stable input fingerprint used to reject a replay key reused with different input. */
export function rpcInputDigest(input: unknown): string {
    return digest(stableJson(input ?? null));
}

const REPLAY_TTL_MS = 5 * 60_000;
const MAX_REPLAY_ENTRIES = 64;

/**
 * Five-minute replay fence for write-mode RPC calls. Capacity is isolated per
 * device+plugin scope: one phone/plugin can fill only its own 64-entry shard.
 * One key maps to one input digest; rejected writes are dropped immediately and
 * successful outcomes remain replayable for five minutes.
 */
export class WriteReplayFence {
    private shards = new Map<string, Map<string, { digest: string; promise: Promise<unknown> }>>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Reserve before starting work, so capacity rejection cannot create an untracked write. */
    run<T>(scope: string, key: string, inputDigest: string, operation: () => Promise<T>): Promise<T> {
        let entries = this.shards.get(scope);
        if (entries === undefined) {
            entries = new Map();
            this.shards.set(scope, entries);
        }
        const existing = entries.get(key);
        if (existing !== undefined) {
            if (existing.digest !== inputDigest) throw new Error('idempotency key was already used with different input');
            return existing.promise as Promise<T>;
        }
        if (entries.size >= MAX_REPLAY_ENTRIES) throw new Error('too many plugin writes');
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const replay = new Promise<T>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const entry = { digest: inputDigest, promise: replay as Promise<unknown> };
        entries.set(key, entry);
        try {
            void Promise.resolve(operation()).then(
                (value) => { this.recordSuccess(scope, key, entry); resolve(value); },
                (error) => { this.deleteIfCurrent(scope, key, entry); reject(error); },
            );
        } catch (error) {
            this.deleteIfCurrent(scope, key, entry);
            reject(error);
        }
        return replay;
    }

    size(scope?: string): number {
        if (scope !== undefined) return this.shards.get(scope)?.size ?? 0;
        return [...this.shards.values()].reduce((total, entries) => total + entries.size, 0);
    }

    private recordSuccess(scope: string, key: string, entry: { digest: string; promise: Promise<unknown> }): void {
        if (this.shards.get(scope)?.get(key) !== entry) return;
        const timerKey = `${scope}\0${key}`;
        const timer = setTimeout(() => this.deleteIfCurrent(scope, key, entry), REPLAY_TTL_MS);
        timer.unref();
        this.timers.set(timerKey, timer);
    }

    private deleteIfCurrent(scope: string, key: string, entry: { digest: string; promise: Promise<unknown> }): void {
        const entries = this.shards.get(scope);
        if (entries?.get(key) !== entry) return;
        const timerKey = `${scope}\0${key}`;
        const timer = this.timers.get(timerKey);
        if (timer !== undefined) { clearTimeout(timer); this.timers.delete(timerKey); }
        entries.delete(key);
        if (entries.size === 0) this.shards.delete(scope);
    }
}

/**
 * Small global cap for concurrent RPC child processes. Slots are transferred
 * directly to the next waiter on release, so `active` never dips below the
 * number of running tasks while a waiter is being resumed and can never exceed
 * the limit.
 */
export class Semaphore {
    private active = 0;
    private queue: { resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }[] = [];
    constructor(private readonly limit: number) {}
    async run<T>(task: () => Promise<T>, queueTimeoutMs?: number): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve, reject) => {
                const waiter: { resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
                this.queue.push(waiter);
                if (queueTimeoutMs !== undefined) {
                    waiter.timer = setTimeout(() => {
                        const index = this.queue.indexOf(waiter);
                        if (index === -1) return;
                        this.queue.splice(index, 1);
                        reject(pluginProcessError('PluginCallQueueTimeoutError', `plugin call queue exceeded ${queueTimeoutMs}ms`));
                    }, queueTimeoutMs);
                    waiter.timer.unref();
                }
            });
        } else {
            this.active += 1;
        }
        try { return await task(); }
        finally {
            const next = this.queue.shift();
            if (next !== undefined) {
                if (next.timer !== undefined) clearTimeout(next.timer);
                next.resolve();
            } else this.active -= 1;
        }
    }
}
