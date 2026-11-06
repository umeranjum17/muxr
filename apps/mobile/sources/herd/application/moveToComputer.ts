import { MOVE_CHUNK_BYTES, type MoveBundle, type RequestParams, type RequestResult } from '@trymuxr/contract';

/** One computer's request line. The source is the connected computer; the destination may be reached on a link of its own. */
export type MoveEndpoint = <T extends MoveRequest>(type: T, params: RequestParams<T>, timeoutMs?: number) => Promise<RequestResult<T>>;
type MoveRequest = 'move.ready' | 'move.export' | 'move.read' | 'move.stage' | 'move.import' | 'move.release';

export type MoveStep = 'checking' | 'packing' | 'sending' | 'resuming';

/** Where a move stopped, in the words the sheet shows. Both computers are always left usable. */
export type MoveOutcome =
    | { ok: true; sessionId: string; cwd: string }
    | { ok: false; stage: MoveStep; code?: string; message: string; sourceKept: true; onDestination: boolean };

export interface MoveRun {
    source: MoveEndpoint;
    /** Resolved when the bundle must be staged; a destination that needs the app to switch to it does so here. */
    destination: () => Promise<MoveEndpoint>;
    /** Read the whole bundle before opening the destination (a destination reached only by switching to it). */
    buffered?: boolean;
    sessionId: string;
    kind: string;
    destinationName: string;
    /** Map the source folder to this destination's home. */
    mapCwd: (cwd: string, destinationHome: string) => string;
    onStep: (step: MoveStep) => void;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
    cancelled?: () => boolean;
}

const RETRY = 'Nothing was lost; try again.';

function codeOf(cause: unknown): string | undefined {
    const code = (cause as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
}

function wordsOf(cause: unknown, fallback: string): string {
    return cause instanceof Error && cause.message.trim() !== '' && codeOf(cause)?.startsWith('move-') ? cause.message : fallback;
}

const byteLength = (base64: string): number => Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

/**
 * The shared core of "Move to another computer", for every agent kind: check the
 * destination, pack the conversation on the source, carry it in bounded chunks,
 * import and resume it there. The source agent is never touched here; the caller
 * retires it only once this resolves ok.
 */
export async function moveToComputer(run: MoveRun): Promise<MoveOutcome> {
    let stage: MoveStep = 'checking';
    let bundle: MoveBundle | undefined;
    let destination: MoveEndpoint | undefined;
    let onDestination = false;
    const fail = (cause: unknown, fallback: string): MoveOutcome => ({
        ok: false, stage, ...(codeOf(cause) === undefined ? {} : { code: codeOf(cause)! }),
        message: wordsOf(cause, fallback), sourceKept: true, onDestination,
    });
    const release = async () => {
        if (bundle === undefined) return;
        await run.source('move.release', { transferId: bundle.transferId }).catch(() => undefined);
        await destination?.('move.release', { transferId: bundle.transferId }).catch(() => undefined);
    };
    const open = async (): Promise<string> => {
        destination = await run.destination();
        const ready = await destination('move.ready', { kind: run.kind });
        if (!ready.ready) throw Object.assign(new Error(ready.message), { code: ready.code });
        return ready.home;
    };
    try {
        run.onStep('checking');
        let home = run.buffered === true ? undefined : await open();
        stage = 'packing';
        run.onStep('packing');
        bundle = await run.source('move.export', { sessionId: run.sessionId }, 240_000);
        const { transferId, bytes } = bundle;
        stage = 'sending';
        run.onStep('sending');
        const held: string[] = [];
        let offset = 0;
        for (let eof = bytes === 0; !eof;) {
            if (run.cancelled?.() === true) throw Object.assign(new Error('Cancelled.'), { code: 'move-cancelled' });
            const piece = await run.source('move.read', { transferId, offset, length: MOVE_CHUNK_BYTES });
            if (destination === undefined) held.push(piece.data);
            else await destination('move.stage', { transferId, offset, data: piece.data });
            offset += byteLength(piece.data);
            run.onProgress?.(Math.min(offset, bytes), bytes);
            eof = piece.eof;
        }
        if (destination === undefined) {
            stage = 'checking';
            home = await open();
            stage = 'sending';
            let at = 0;
            for (const data of held) {
                await destination!('move.stage', { transferId, offset: at, data });
                at += byteLength(data);
            }
        }
        stage = 'resuming';
        run.onStep('resuming');
        onDestination = true;
        const imported = await destination!('move.import', {
            transferId, kind: bundle.kind, conversation: bundle.conversation, bytes, digest: bundle.digest,
            cwd: run.mapCwd(bundle.cwd, home ?? '~'), ...(bundle.taskTitle === undefined ? {} : { taskTitle: bundle.taskTitle }),
        }, 120_000);
        await release();
        return { ok: true, sessionId: imported.sessionId, cwd: imported.cwd };
    } catch (cause) {
        // Only a failure after the import ran can have left the conversation on the destination.
        if (stage !== 'resuming' || ['move-corrupt', 'move-exists', 'move-not-ready'].includes(codeOf(cause) ?? '')) onDestination = false;
        const outcome = fail(cause, stage === 'sending'
            ? `The connection to ${run.destinationName} dropped before the conversation arrived. ${RETRY}`
            : `Couldn't finish moving to ${run.destinationName}. ${RETRY}`);
        await release();
        return outcome;
    }
}
