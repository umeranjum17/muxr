import type { PluginAction, PluginManifestV1, PluginRpcCapability, PluginScreenButtonNode, PluginScreenContribution, PluginScreenNode, RequestParams } from '@muxr/contract';
import { MAX_RPC_DISPLAY_BYTES, capUtf8Bytes, defaultPluginText, sanitizeDisplayText } from '@muxr/contract';

/** `{{data.dotted.path}}` bindings only; no expressions. Unresolved paths render empty. */
const BINDING = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** The screen data root binds under `data.*`; repeat entries bind under `item.*`. */
export function resolvePath(data: unknown, path: string, item?: unknown): unknown {
    let value: unknown;
    let segments: string;
    if (path.startsWith('item.')) {
        value = item;
        segments = path.slice(5);
    } else {
        value = data;
        segments = path.startsWith('data.') ? path.slice(5) : path;
    }
    for (const segment of segments.split('.')) {
        if (value === null || value === undefined) return undefined;
        if (typeof value !== 'object') return undefined;
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

export function bindText(template: string, data: unknown, item?: unknown): string {
    if (!template.includes('{{')) {
        return capUtf8Bytes(sanitizeDisplayText(template), MAX_RPC_DISPLAY_BYTES);
    }
    const bound = template.replace(BINDING, (_match, path: string) => {
        const value = resolvePath(data, path, item);
        return value === undefined || value === null ? '' : String(value);
    });
    // Defensive: bound values come from the host already capped/sanitized, but
    // a template with several bindings can still exceed one display budget.
    return capUtf8Bytes(sanitizeDisplayText(bound), MAX_RPC_DISPLAY_BYTES);
}

export type ScreenFieldValues = Record<string, string | boolean>;

export function initialFieldValues(screen: PluginScreenContribution, data?: unknown): ScreenFieldValues {
    const values: ScreenFieldValues = {};
    collectFieldDefaults(screen.children, values, data);
    return values;
}

function collectFieldDefaults(nodes: PluginScreenNode[], values: ScreenFieldValues, data?: unknown): void {
    for (const node of nodes) {
        if (node.type !== 'field') {
            if (node.type === 'section') collectFieldDefaults(node.children, values, data);
            continue;
        }
        if (node.kind === 'switch') values[node.id] = node.value === 'true';
        else if (node.kind === 'select') values[node.id] = node.value ?? (node.options?.[0] === undefined ? '' : defaultPluginText(node.options[0]));
        else values[node.id] = node.value === undefined ? '' : bindText(node.value, data);
    }
}

/** The current values of the fields a button references become its RPC input. */
/**
 * A button sends its declared fields plus the params the screen was opened
 * with, so a detail screen can act on the record you navigated to instead of
 * making you retype it. Fields win on a key collision: what you typed is what
 * you meant.
 */
export function buttonInput(button: PluginScreenButtonNode, fields: ScreenFieldValues, params?: Record<string, string>): unknown {
    const named = button.fields === undefined || button.fields.length === 0
        ? undefined
        : Object.fromEntries(button.fields.map((id) => [id, fields[id]]));
    if (params === undefined || Object.keys(params).length === 0) return named;
    return { ...params, ...(named ?? {}) };
}

export function rpcFor(manifest: PluginManifestV1, contributionId: string): PluginRpcCapability | undefined {
    return manifest.contributions.find((contribution): contribution is PluginRpcCapability =>
        contribution.slot === 'host.rpc' && contribution.id === contributionId);
}

export function screenCallParams(options: {
    pluginId: string;
    manifestHash: string;
    contributionId: string;
    input?: unknown;
    mode: 'read' | 'write';
    idempotencyKey?: string;
}): RequestParams<'plugin.call'> {
    return {
        pluginId: options.pluginId,
        manifestHash: options.manifestHash,
        contributionId: options.contributionId,
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.mode === 'write' ? { idempotencyKey: options.idempotencyKey! } : {}),
    };
}

export type ScreenCallOutcome = { ok: true; text: string } | { ok: false; text: string };

function displayText(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return capUtf8Bytes(sanitizeDisplayText(text), MAX_RPC_DISPLAY_BYTES);
}

/** Load a screen's declared data RPC (read mode only). */
export async function loadScreenData(
    dataContributionId: string,
    manifest: PluginManifestV1,
    pluginId: string,
    manifestHash: string,
    request: (type: 'plugin.call', params: RequestParams<'plugin.call'>) => Promise<unknown>,
    input?: unknown,
): Promise<unknown> {
    const rpc = rpcFor(manifest, dataContributionId);
    if (rpc === undefined || rpc.mode !== 'read') return undefined;
    return request('plugin.call', screenCallParams({ pluginId, manifestHash, contributionId: rpc.id, ...(input === undefined ? {} : { input }), mode: 'read' }));
}

/** Stable canonical input solely for hashing; plaintext is never retained by the key store. */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * One idempotency key per write slot while its input is unchanged. A failed or
 * ambiguous write keeps its key so a retry reuses it: if the first attempt
 * recorded a successful outcome the host replays it, and if it genuinely failed
 * the host drops the rejection and the retry re-executes. Success (or a changed
 * input) clears the key.
 */
function inputFingerprint(value: unknown): string {
    const canonical = stableStringify(value ?? null);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < canonical.length; index += 1) {
        const code = canonical.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
    return `${canonical.length}:${first.toString(16)}:${second.toString(16)}`;
}

export class WriteKeyStore {
    private entries = new Map<string, { key: string; digest: string }>();

    keyFor(slot: string, input: unknown, mint: () => string): string {
        const digest = inputFingerprint(input);
        const entry = this.entries.get(slot);
        if (entry !== undefined && entry.digest === digest) return entry.key;
        const key = mint();
        if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(slot, { key, digest });
        return key;
    }

    clear(slot: string): void { this.entries.delete(slot); }
}

/** Shared across declarative and RPC-sourced actions, including remounts after an ambiguous failure. */
export const sharedPluginWriteKeys = new WriteKeyStore();

export function shouldReloadAfterAction(manifest: PluginManifestV1, action: PluginAction, succeeded: boolean): boolean {
    if (!succeeded) return false;
    const call = action.type === 'plugin.call' ? action
        : action.type === 'secure-prompt' ? action.submit
        : action.type === 'confirm' ? action.action
        : undefined;
    return call !== undefined && rpcFor(manifest, call.contributionId)?.mode === 'write';
}

/**
 * Run one screen button through plugin.call. Write RPCs reuse the client's
 * retained idempotency key while the input is unchanged, so an ambiguous failure
 * can be retried without duplicating a successful write; success clears the
 * retained key.
 */
export async function runScreenButton(
    args: {
        button: PluginScreenButtonNode;
        fields: ScreenFieldValues;
        pluginId: string;
        manifestHash: string;
        manifest: PluginManifestV1;
        writeKeys: WriteKeyStore;
        params?: Record<string, string>;
        slot: string;
        newIdempotencyKey: () => string;
    },
    request: (type: 'plugin.call', params: RequestParams<'plugin.call'>) => Promise<unknown>,
): Promise<ScreenCallOutcome> {
    if (args.button.action.type !== 'plugin.call') return { ok: false, text: 'Action is not an RPC' };
    const rpc = rpcFor(args.manifest, args.button.action.contributionId);
    if (rpc === undefined) return { ok: false, text: 'RPC unavailable' };
    try {
        const input = buttonInput(args.button, args.fields, args.params);
        const idempotencyKey = rpc.mode === 'write' ? args.writeKeys.keyFor(args.slot, input, args.newIdempotencyKey) : undefined;
        const params = screenCallParams({
            pluginId: args.pluginId,
            manifestHash: args.manifestHash,
            contributionId: rpc.id,
            ...(input === undefined ? {} : { input }),
            mode: rpc.mode,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        const result = await request('plugin.call', params);
        if (idempotencyKey !== undefined) args.writeKeys.clear(args.slot);
        return { ok: true, text: displayText(result) };
    } catch (error) {
        return { ok: false, text: displayText(error instanceof Error ? error.message : String(error)) };
    }
}
