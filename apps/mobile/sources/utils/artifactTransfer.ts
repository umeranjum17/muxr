/**
 * Progressive artifact downloads over the encrypted artifact channel.
 *
 * Bytes arrive as bounded `artifact.read` chunks and go straight to a sink the
 * platform owns (a device file, the browser's private file system), so no layer
 * ever holds the whole file. Progress lives in a small store the Shared
 * Artifacts rows read. A dropped connection pauses at the last written byte and
 * resumes from it on reconnect; a later attempt resumes from whatever an earlier
 * one kept on disk. Artifact ids are content hashes, so kept bytes are only
 * ever resumed into the same content.
 */
import { AppState } from 'react-native';
import { create } from 'zustand';
import { storage } from '@/catalog/store';
import { sync } from '@/catalog/sync';
import { decodeBase64 } from '@/encryption/base64';
import { artifactChunkHash } from '@/utils/artifactChunkHash';

export type DownloadableArtifact = { id: string; name: string; mimeType: string; size: number; at?: number };

export type ArtifactTransfer =
    /** `waiting`: the connection dropped; resumes by itself when it returns. */
    | { status: 'downloading' | 'waiting'; received: number; total: number; bytesPerSecond?: number }
    | { status: 'failed'; received: number; total: number; message: string }
    | { status: 'done' | 'ready'; total: number };

/** Where a download's bytes land. `offset` is how many an earlier attempt kept. */
export interface TransferSink {
    readonly offset: number;
    write(bytes: Uint8Array): void | Promise<void>;
    /** Close, keeping the bytes written so far for a resume. */
    pause(): void | Promise<void>;
    /** Close and remove the partial bytes. */
    discard(): void | Promise<void>;
    /** Close a complete file; returns what `open` hands to the platform. */
    finish(): string | Promise<string>;
}

export interface TransferPlatform {
    sink(artifact: DownloadableArtifact, sessionId: string): TransferSink | Promise<TransferSink>;
    /** Hand a finished file to the OS: installer, viewer or share sheet. */
    open(uri: string, artifact: DownloadableArtifact): void | Promise<void>;
    deliverBeforeDone?: boolean;
}

/** The host serves at most 512 KiB per read; four in flight keep a slow link busy. */
const CHUNK_BYTES = 512 * 1024;
const WINDOW = 4;
const PUBLISH_MS = 250;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
export const LARGE_FILE_ERROR = "This browser can't save large files here";

export const useArtifactTransfers = create<Record<string, ArtifactTransfer>>(() => ({}));

class ArtifactChanged extends Error {
    constructor(message = 'Changed on the computer. Download it again.') {
        super(message);
    }
}

interface Job {
    key: string;
    sessionId: string;
    artifact: DownloadableArtifact;
    platform: TransferPlatform;
    /** The host's content id for this download; every chunk must carry it. */
    pinnedId: string | undefined;
    /** The attempt in flight; none while paused. */
    attempt: Promise<void> | undefined;
    cancelled: boolean;
    resumeOnConnect: boolean;
    settle: { resolve: () => void; reject: (error: Error) => void };
    done: Promise<void>;
}

const jobs = new Map<string, Job>();
/** Cancelled downloads still closing their file; a new attempt at the same file waits for them. */
const closing = new Map<string, Promise<void>>();
let connectionEpoch = 0;

export function artifactTransferKey(sessionId: string, artifact: Pick<DownloadableArtifact, 'id' | 'name'>): string {
    return JSON.stringify([sessionId, artifact.id, artifact.name]);
}

function owns(job: Job): boolean {
    return !job.cancelled && jobs.get(job.key) === job;
}

function start(job: Job): void {
    if (job.attempt !== undefined || !owns(job)) return;
    job.attempt = run(job).finally(() => {
        job.attempt = undefined;
        if (job.resumeOnConnect && storage.getState().socketStatus === 'connected' && owns(job)) {
            job.resumeOnConnect = false;
            start(job);
        }
    });
}

function publish(key: string, transfer: ArtifactTransfer | undefined): void {
    useArtifactTransfers.setState((all) => {
        const next = { ...all };
        if (transfer === undefined) delete next[key];
        else next[key] = transfer;
        return next;
    }, true);
}

/**
 * Start a download, or join the one already running for this artifact.
 * Resolves once the file is on the device and handed to the platform; stays
 * pending while it waits for a dropped connection.
 */
export function transferArtifact(sessionId: string, artifact: DownloadableArtifact, platform: TransferPlatform): Promise<void> {
    const key = artifactTransferKey(sessionId, artifact);
    const existing = jobs.get(key);
    if (existing !== undefined) {
        start(existing);
        return existing.done;
    }
    let settle!: Job['settle'];
    const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    const job: Job = {
        key, sessionId, artifact, platform, settle, done,
        pinnedId: CONTENT_HASH.test(artifact.id) ? artifact.id : undefined,
        attempt: undefined,
        cancelled: false,
        resumeOnConnect: false,
    };
    jobs.set(key, job);
    watchConnection();
    start(job);
    return done;
}

/** Stop a running or paused download and delete what it kept. */
export function cancelArtifactTransfer(key: string): void {
    const job = jobs.get(key);
    if (job === undefined) return;
    jobs.delete(key);
    publish(key, undefined);
    job.cancelled = true;
    job.settle.reject(new Error('Download cancelled.'));
    // A running attempt deletes its bytes once the chunk it is waiting on
    // lands; a paused one has nobody left to, so open its file and drop it.
    const cleanup = job.attempt ?? Promise.resolve(job.platform.sink(job.artifact, job.sessionId)).then((sink) => sink.discard());
    const closed: Promise<void> = cleanup.catch(() => undefined).finally(() => {
        if (closing.get(key) === closed) closing.delete(key);
    });
    closing.set(key, closed);
}

export async function clearArtifactDownloads(): Promise<void> {
    for (const id of jobs.keys()) cancelArtifactTransfer(id);
    await Promise.all(closing.values());
    const { clearPartialDownloads } = await import('@/utils/downloadArtifact');
    await clearPartialDownloads();
}

class MissingArtifactTime extends Error {}

async function readChunk(job: Job, at: number, length: number, requireTime = false): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const chunk = await sync.artifactRead(job.sessionId, job.pinnedId ?? job.artifact.id, at, length, 60_000);
        if (chunk === null || chunk.offset !== at || chunk.size !== job.artifact.size) throw new ArtifactChanged();
        job.pinnedId ??= chunk.id;
        if (chunk.id !== job.pinnedId) throw new ArtifactChanged();
        if (requireTime && chunk.at === undefined) throw new MissingArtifactTime();
        const bytes = decodeBase64(chunk.data);
        if (bytes.length !== length) throw new ArtifactChanged();
        if (chunk.sha256 !== undefined && await artifactChunkHash(bytes) !== chunk.sha256) {
            if (attempt === 0) continue;
            throw new ArtifactChanged('Download failed integrity check. Try again.');
        }
        return bytes;
    }
    throw new ArtifactChanged();
}

async function run(job: Job): Promise<void> {
    const { artifact } = job;
    await closing.get(job.key);
    let sink: TransferSink | undefined;
    let received = 0;
    const epoch = connectionEpoch;
    let rate: number | undefined;
    let publishedAt = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    // At most a few renders a second, but never sitting on stale bytes when
    // chunks stop arriving: the latest count always lands.
    const showProgress = (): void => {
        if (trailing !== undefined) return;
        const wait = publishedAt + PUBLISH_MS - Date.now();
        const show = (): void => {
            trailing = undefined;
            publishedAt = Date.now();
            if (owns(job)) publish(job.key, { status: 'downloading', received, total: artifact.size, bytesPerSecond: rate });
        };
        if (wait <= 0) show();
        else trailing = setTimeout(show, wait);
    };
    try {
        sink = await job.platform.sink(artifact, job.sessionId);
        if (!owns(job)) throw new Error('Download cancelled.');
        received = sink.offset;
        if (received > 0) {
            try {
                await readChunk(job, 0, Math.min(CHUNK_BYTES, artifact.size), true);
            } catch (error) {
                if (!(error instanceof MissingArtifactTime)) throw error;
                await sink.discard();
                if (!owns(job)) return;
                sink = await job.platform.sink(artifact, job.sessionId);
                if (!owns(job)) throw new Error('Download cancelled.');
                received = sink.offset;
            }
        }
        if (!owns(job)) throw new Error('Download cancelled.');
        let next = received;
        let sampleAt = Date.now();
        let sampleBytes = received;
        if (received < artifact.size) publish(job.key, { status: 'downloading', received, total: artifact.size });
        // Requests go out in order and are written in order; a window of them
        // hides the round trip without holding more than WINDOW chunks.
        const inflight: Promise<Uint8Array>[] = [];
        const fill = (): void => {
            while (inflight.length < WINDOW && next < artifact.size) {
                const length = Math.min(CHUNK_BYTES, artifact.size - next);
                const request = readChunk(job, next, length);
                request.catch(() => undefined);
                inflight.push(request);
                next += length;
            }
        };
        fill();
        while (inflight.length > 0) {
            // Never race each chunk against one long-lived cancel promise: every
            // race leaves a reaction on it that keeps that chunk's bytes alive.
            const bytes = await inflight.shift()!;
            if (!owns(job)) throw new Error('Download cancelled.');
            await sink.write(bytes);
            if (!owns(job)) throw new Error('Download cancelled.');
            received += bytes.length;
            fill();
            const now = Date.now();
            if (now - sampleAt >= 1000) {
                const instant = (received - sampleBytes) / ((now - sampleAt) / 1000);
                rate = rate === undefined ? instant : rate * 0.7 + instant * 0.3;
                sampleAt = now;
                sampleBytes = received;
            }
            showProgress();
        }
        const uri = await sink.finish();
        if (!owns(job)) throw new Error('Download cancelled.');
        clearTimeout(trailing);
        if (job.platform.deliverBeforeDone) {
            let delivered = false;
            if (AppState.currentState === 'active' && document.visibilityState !== 'hidden') {
                try { await job.platform.open(uri, artifact); delivered = true; } catch {}
            }
            if (!owns(job)) return;
            jobs.delete(job.key);
            publish(job.key, { status: delivered ? 'done' : 'ready', total: artifact.size });
            job.settle.resolve();
        } else {
            jobs.delete(job.key);
            publish(job.key, { status: 'done', total: artifact.size });
            job.settle.resolve();
            if (AppState.currentState === 'active') {
                try { job.platform.open(uri, artifact); } catch {}
            }
        }
    } catch (error) {
        clearTimeout(trailing);
        if (!owns(job)) {
            try { await sink?.discard(); } catch {}
            return;
        }
        if (error instanceof ArtifactChanged) {
            try { await sink?.discard(); } catch {}
            if (owns(job)) fail(job, 0, error.message, error);
            return;
        }
        if (error instanceof Error && error.message === LARGE_FILE_ERROR) {
            fail(job, received, error.message, error);
            return;
        }
        try { await sink?.pause(); } catch (pauseError) {
            if (owns(job)) fail(job, received, 'Download stopped', pauseError);
            else try { await sink?.discard(); } catch {}
            return;
        }
        if (!owns(job)) {
            try { await sink?.discard(); } catch {}
            return;
        }
        if (storage.getState().socketStatus !== 'connected' || connectionEpoch !== epoch) {
            job.resumeOnConnect = true;
            publish(job.key, { status: 'waiting', received, total: artifact.size });
            return;
        }
        fail(job, received, 'Download stopped', error);
    }
}

function fail(job: Job, received: number, message: string, cause: unknown): void {
    if (!owns(job)) return;
    jobs.delete(job.key);
    publish(job.key, { status: 'failed', received, total: job.artifact.size, message });
    job.settle.reject(cause instanceof Error ? cause : new Error(String(cause)));
}

let watching = false;

/** Paused downloads pick up where they stopped when the connection returns. */
function watchConnection(): void {
    if (watching) return;
    watching = true;
    storage.subscribe((state, previous) => {
        if (state.socketStatus === previous.socketStatus) return;
        if (state.socketStatus !== 'connected') {
            connectionEpoch++;
            return;
        }
        for (const job of jobs.values()) if (job.resumeOnConnect) start(job);
    });
}
