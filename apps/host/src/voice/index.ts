/**
 * Product facade for Realtime voice.
 *
 * The adapter runtime is ESM that lives beside the packed host bundle (or in
 * `apps/host/src/voice` in a checkout) and is spawned as a child process for
 * every stream. The facade loads it from that real location instead of
 * inlining it into the host bundle: one copy of the runtime serves both the
 * host's in-process calls and the stream child, and no repo path enters the
 * published artifact.
 *
 * This module is the single typed seam. Nothing outside `apps/host/src/voice`
 * reaches into the adapters directly.
 */
import { existsSync } from 'node:fs';
import type { VoiceProviderCatalog, VoiceProviderDescription, VoiceStatus } from './product.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Where the adapter runtime lives: next to the packed host bundle, or in the
 * checkout when running from `apps/host/dist`.
 */
export function voiceRuntimeRoot(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
        for (const candidate of [join(directory, 'voice'), join(directory, 'apps', 'host', 'src', 'voice')]) {
            if (existsSync(join(candidate, 'stream.mjs'))) return candidate;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error('muxr realtime voice runtime not found; run yarn build');
}

export type {
    VoiceProviderEntry,
    VoiceProviderCatalog,
    VoiceProviderDescription,
    VoiceStatus,
} from './product.mjs';

type VoiceRuntime = typeof import('./product.mjs');

let runtime: Promise<VoiceRuntime> | undefined;

function load(): Promise<VoiceRuntime> {
    // A computed specifier keeps the runtime out of the host bundle, so the
    // host and the stream child always run the same files.
    runtime ??= import(pathToFileURL(join(voiceRuntimeRoot(), 'product.mjs')).href) as Promise<VoiceRuntime>;
    return runtime;
}

export async function voiceStatus(): Promise<VoiceStatus> {
    return (await load()).voiceStatus();
}

export async function voiceProviderList(): Promise<VoiceProviderCatalog> {
    return (await load()).voiceProviderList();
}

export async function voiceProviderSet(providerId: unknown): Promise<VoiceProviderCatalog> {
    return (await load()).voiceProviderSet(providerId);
}

export async function voiceProviderDescribe(id?: unknown): Promise<VoiceProviderDescription> {
    return (await load()).voiceProviderDescribe(id);
}

export async function voiceKeySet(key: unknown, providerId?: unknown): Promise<void> {
    await (await load()).voiceKeySet(key, providerId);
}

export async function voiceKeyClear(providerId?: unknown): Promise<void> {
    await (await load()).voiceKeyClear(providerId);
}

export async function voiceReport(input: unknown): Promise<{ say: string }> {
    return (await load()).voiceReport(input);
}
