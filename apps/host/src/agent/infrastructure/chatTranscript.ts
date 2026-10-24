import { open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import type { ChatRead } from '@trymuxr/contract';
import { transcriptFiles, transcriptRoots, type TranscriptRoots } from '../../usage/index.js';
import { CHAT_MESSAGES_MAX, chatMessagesFrom, imageTypeOf, type ChatHarness, type ChatImageSource } from '../domain/chatMessages.js';
import { MAX_FETCH_BYTES } from './artifactWatcher.js';

/** The conversation Herdr published for an agent: a harness session id, or the log's own path. */
export interface ChatConversation {
    agent: string | undefined;
    cwd: string;
    ref: { kind: 'id' | 'path'; value: string };
}

/** Only the end of a log is read; a long session is hundreds of megabytes. */
const TAIL_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** How long a search that found no log is not repeated: the agent has not written one yet. */
const MISS_MS = 5_000;
/** The image tables of this many logs are kept: the chats open on phones. */
const IMAGE_LOGS = 8;

function harnessOf(agent: string | undefined): ChatHarness | undefined {
    return agent === 'claude' || agent === 'pi' ? agent : undefined;
}

function rootsOf(harness: ChatHarness, roots: TranscriptRoots): string[] {
    return harness === 'claude' ? roots.claude ?? [] : roots.pi === undefined ? [] : [roots.pi];
}

/** Claude Code names a project folder after its working directory with every other character as a dash. */
function claudeProjectFolder(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

async function inside(root: string, path: string): Promise<boolean> {
    try {
        const [base, real] = await Promise.all([realpath(root), realpath(path)]);
        return real.startsWith(base + sep);
    } catch { return false; }
}

export class ChatTranscripts {
    private readonly found = new Map<string, string>();
    private readonly missed = new Map<string, number>();
    /** By log: the images its last read gave the phone, by the id it gave each. */
    private readonly images = new Map<string, Map<string, ChatImageSource>>();

    constructor(private readonly roots: () => TranscriptRoots = () => transcriptRoots()) {}

    private async locate(harness: ChatHarness, conversation: ChatConversation): Promise<string | undefined> {
        const roots = rootsOf(harness, this.roots());
        const { kind, value } = conversation.ref;
        if (kind === 'path') {
            if (!isAbsolute(value) || !value.endsWith('.jsonl')) return undefined;
            for (const root of roots) if (await inside(root, value)) return value;
            return undefined;
        }
        if (!SAFE_ID.test(value)) return undefined;
        const key = `${harness}:${value}`;
        const known = this.found.get(key);
        if (known !== undefined && await stat(known).then(() => true, () => false)) return known;
        if (harness === 'claude') {
            for (const root of roots) {
                const path = join(root, claudeProjectFolder(conversation.cwd), `${value}.jsonl`);
                if (await stat(path).then(() => true, () => false)) { this.found.set(key, path); return path; }
            }
        }
        if ((this.missed.get(key) ?? 0) > Date.now()) return undefined;
        // Pi names a log `<time>_<id>.jsonl` under a nest of folders; search for the id.
        for (const root of roots) {
            for (const path of transcriptFiles(root)) {
                if (path.endsWith(`${sep}${value}.jsonl`) || path.endsWith(`_${value}.jsonl`)) { this.found.set(key, path); return path; }
            }
        }
        this.missed.set(key, Date.now() + MISS_MS);
        return undefined;
    }

    /** The agent's conversation as whole messages, or why it has none. `revision` is the last one the caller was given. */
    async read(conversation: ChatConversation | undefined, revision?: string): Promise<ChatRead> {
        const harness = harnessOf(conversation?.agent);
        if (conversation === undefined || harness === undefined) return { state: 'unavailable', reason: 'unsupported-agent' };
        const path = await this.locate(harness, conversation);
        if (path === undefined) return { state: 'unavailable', reason: 'no-conversation' };
        const handle = await open(path, 'r');
        try {
            const { size, mtimeMs } = await handle.stat();
            const next = `${size}:${Math.trunc(mtimeMs)}`;
            if (next === revision) return { state: 'unchanged' };
            const start = Math.max(0, size - TAIL_BYTES);
            const bytes = Buffer.alloc(size - start);
            await handle.read(bytes, 0, bytes.length, start);
            const lines = bytes.toString('utf8').split('\n');
            // A tail begins mid-line: its first line is a fragment.
            if (start > 0) lines.shift();
            const images = new Map<string, ChatImageSource>();
            const all = chatMessagesFrom(harness, lines, conversation.cwd, images);
            const messages = all.slice(-CHAT_MESSAGES_MAX);
            // A reply names files it meant to make too: only an image that is there is shown.
            const missing = new Set<string>();
            await Promise.all([...images].map(async ([id, source]) => {
                if ('path' in source && !await stat(source.path).then((file) => file.isFile(), () => false)) missing.add(id);
            }));
            for (const message of messages) {
                if (message.images?.some((image) => missing.has(image.id))) {
                    const kept = message.images.filter((image) => !missing.has(image.id));
                    if (kept.length > 0) message.images = kept; else delete message.images;
                }
            }
            for (const id of missing) images.delete(id);
            this.images.delete(path);
            this.images.set(path, images);
            if (this.images.size > IMAGE_LOGS) this.images.delete(this.images.keys().next().value!);
            return { state: 'ok', revision: next, messages, truncated: start > 0 || all.length > CHAT_MESSAGES_MAX };
        } finally {
            await handle.close();
        }
    }

    /** One image a read gave the phone; null once it is gone, is no longer an image, or is too big for one frame. */
    async image(conversation: ChatConversation | undefined, imageId: string): Promise<{ mimeType: string; data: string } | null> {
        const harness = harnessOf(conversation?.agent);
        if (conversation === undefined || harness === undefined) return null;
        const path = await this.locate(harness, conversation);
        if (path === undefined) return null;
        // A host that restarted since the phone's read has no table yet: read the log again.
        if (!this.images.get(path)?.has(imageId)) await this.read(conversation);
        const source = this.images.get(path)?.get(imageId);
        if (source === undefined) return null;
        if (!('path' in source)) return source.data.length <= Math.ceil(MAX_FETCH_BYTES / 3) * 4 ? source : null;
        const mimeType = imageTypeOf(source.path);
        const file = await stat(source.path).catch(() => undefined);
        if (mimeType === undefined || file?.isFile() !== true || file.size > MAX_FETCH_BYTES) return null;
        return { mimeType, data: (await readFile(source.path)).toString('base64') };
    }
}
