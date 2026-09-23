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

export type DownloadableArtifact = { id: string; name: string; mimeType: string; size: number };

export type ArtifactTransfer =
    /** `waiting`: the connection dropped; resumes by itself when it returns. */
    | { status: 'downloading' | 'waiting'; received: number; total: number; bytesPerSecond?: number }
    | { status: 'failed'; received: number; total: number; message: string }
    | { status: 'done'; total: number };

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
    sink(artifact: DownloadableArtifact): TransferSink | Promise<TransferSink>;
    /** Hand a finished file to the OS: installer, viewer or share sheet. */
    open(uri: string, artifact: DownloadableArtifact): void;
}

/** The host serves at most 512 KiB per read; four in flight keep a slow link busy. */
const CHUNK_BYTES = 512 * 1024;
const WINDOW = 4;
const PUBLISH_MS = 250;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

export const useArtifactTransfers = create<Record<string, ArtifactTransfer>>(() => ({}));

class ArtifactChanged extends Error {
    constructor() {
        super('Changed on the computer. Refresh and try again.');
    }
}

interface Job {
    sessionId: string;
    artifact: DownloadableArtifact;
    platform: TransferPlatform;
    /** The host's content id for this download; every chunk must carry it. */
    pinnedId: string | undefined;
    /** The attempt in flight; none while paused. */
    attempt: Promise<void> | undefined;
    cancelled: boolean;
    settle: { resolve: () => void; reject: (error: Error) => void };
    done: Promise<void>;
}

const jobs = new Map<string, Job>();
/** Cancelled downloads still closing their file; a new attempt at the same file waits for them. */
const closing = new Map<string, Promise<void>>();

function start(job: Job): void {
    if (job.attempt !== undefined) return;
    job.attempt = run(job).finally(() => { job.attempt = undefined; });
}

function publish(id: string, transfer: ArtifactTransfer | undefined): void {
    useArtifactTransfers.setState((all) => {
        const next = { ...all };
        if (transfer === undefined) delete next[id];
        else next[id] = transfer;
        return next;
    }, true);
}

/**
 * Start a download, or join the one already running for this artifact.
 * Resolves once the file is on the device and handed to the platform; stays
 * pending while it waits for a dropped connection.
 */
export function transferArtifact(sessionId: string, artifact: DownloadableArtifact, platform: TransferPlatform): Promise<void> {
    const existing = jobs.get(artifact.id);
    if (existing !== undefined) {
        start(existing);
        return existing.done;
    }
    let settle!: Job['settle'];
    const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    const job: Job = {
        sessionId, artifact, platform, settle, done,
        pinnedId: CONTENT_HASH.test(artifact.id) ? artifact.id : undefined,
        attempt: undefined,
        cancelled: false,
    };
    jobs.set(artifact.id, job);
    watchConnection();
    start(job);
    return done;
}

/** Stop a running or paused download and delete what it kept. */
export function cancelArtifactTransfer(artifactId: string): void {
    const job = jobs.get(artifactId);
    if (job === undefined) return;
    jobs.delete(artifactId);
    publish(artifactId, undefined);
    job.cancelled = true;
    job.settle.reject(new Error('Download cancelled.'));
    // A running attempt deletes its bytes once the chunk it is waiting on
    // lands; a paused one has nobody left to, so open its file and drop it.
    const cleanup = job.attempt ?? Promise.resolve(job.platform.sink(job.artifact)).then((sink) => sink.discard());
    const closed: Promise<void> = cleanup.catch(() => undefined).finally(() => {
        if (closing.get(artifactId) === closed) closing.delete(artifactId);
    });
    closing.set(artifactId, closed);
}

async function readChunk(job: Job, at: number, length: number): Promise<Uint8Array> {
    const chunk = await sync.artifactRead(job.sessionId, job.pinnedId ?? job.artifact.id, at, length, 60_000);
    if (chunk === null || chunk.offset !== at || chunk.size !== job.artifact.size) throw new ArtifactChanged();
    job.pinnedId ??= chunk.id;
    if (chunk.id !== job.pinnedId) throw new ArtifactChanged();
    const bytes = decodeBase64(chunk.data);
    if (bytes.length !== length) throw new ArtifactChanged();
    return bytes;
}

async function run(job: Job): Promise<void> {
    const { artifact } = job;
    await closing.get(artifact.id);
    let sink: TransferSink | undefined;
    let received = 0;
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
            publish(artifact.id, { status: 'downloading', received, total: artifact.size, bytesPerSecond: rate });
        };
        if (wait <= 0) show();
        else trailing = setTimeout(show, wait);
    };
    try {
        sink = await job.platform.sink(artifact);
        if (job.cancelled) throw new Error('Download cancelled.');
        received = sink.offset;
        let next = received;
        let sampleAt = Date.now();
        let sampleBytes = received;
        if (received < artifact.size) publish(artifact.id, { status: 'downloading', received, total: artifact.size });
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
            if (job.cancelled) throw new Error('Download cancelled.');
            await sink.write(bytes);
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
        clearTimeout(trailing);
        jobs.delete(artifact.id);
        publish(artifact.id, { status: 'done', total: artifact.size });
        job.settle.resolve();
        // Launching an installer or share sheet from the background is refused
        // by the OS; the finished row opens it on the next tap instead.
        if (AppState.currentState === 'active') job.platform.open(uri, artifact);
    } catch (error) {
        clearTimeout(trailing);
        if (job.cancelled) {
            await sink?.discard();
            return;
        }
        if (error instanceof ArtifactChanged) {
            await sink?.discard();
            fail(job, 0, error.message, error);
            return;
        }
        await sink?.pause();
        if (storage.getState().socketStatus !== 'connected') {
            publish(artifact.id, { status: 'waiting', received, total: artifact.size });
            return;
        }
        fail(job, received, 'Download stopped', error);
    }
}

function fail(job: Job, received: number, message: string, cause: unknown): void {
    jobs.delete(job.artifact.id);
    publish(job.artifact.id, { status: 'failed', received, total: job.artifact.size, message });
    job.settle.reject(cause instanceof Error ? cause : new Error(String(cause)));
}

let watching = false;

/** Paused downloads pick up where they stopped when the connection returns. */
function watchConnection(): void {
    if (watching) return;
    watching = true;
    storage.subscribe((state, previous) => {
        if (state.socketStatus !== 'connected' || previous.socketStatus === 'connected') return;
        for (const job of jobs.values()) start(job);
    });
}
