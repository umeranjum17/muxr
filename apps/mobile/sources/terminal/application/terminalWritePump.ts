/**
 * Single-flight native terminal writer. Adjacent frames are combined into one
 * native write. A bounded backlog fails explicitly and requests a repaint after
 * the admitted native write has settled.
 */

export type TerminalWriteFrame = {
    bytes: string;
    ready?: boolean;
};

export type TerminalWritePump = {
    push: (frame: TerminalWriteFrame) => void;
    cancel: () => Promise<void>;
};

export function createTerminalWritePump(options: {
    write: (bytes: string, ready: boolean) => Promise<unknown>;
    combineText: (frames: readonly string[]) => string;
    schedule: (run: () => void) => unknown;
    cancelSchedule: (handle: unknown) => void;
    onRejected: (error: unknown) => void;
}): TerminalWritePump {
    const pending: TerminalWriteFrame[] = [];
    // Base64 is ASCII. Bound retained encoded characters as well as record count.
    const maxPendingChars = 64 * 1024 * 1024;
    const maxPendingFrames = 128;
    let pendingChars = 0;
    let overflow: Error | undefined;
    let generation = 0;
    let writing = false;
    let scheduled: unknown;
    let inFlight: Promise<void> | undefined;

    const nextPayload = (): { bytes: string; ready: boolean } | undefined => {
        if (pending.length === 0) return undefined;
        const texts: string[] = [];
        let ready = false;
        while (pending.length > 0) {
            const frame = pending.shift()!;
            pendingChars -= frame.bytes.length;
            texts.push(frame.bytes);
            ready ||= frame.ready === true;
        }
        return { bytes: texts.length === 1 ? texts[0]! : options.combineText(texts), ready };
    };

    const kick = (): void => {
        if (writing || scheduled !== undefined || pending.length === 0) return;
        scheduled = options.schedule(() => {
            scheduled = undefined;
            if (writing) return;
            const payload = nextPayload();
            if (payload === undefined) return;
            writing = true;
            const admittedGen = generation;
            const admitted = Promise.resolve().then(() => options.write(payload.bytes, payload.ready));
            inFlight = admitted.then(() => undefined, () => undefined);
            void admitted.then(
                () => finish(admittedGen, false),
                (error: unknown) => finish(admittedGen, true, error),
            );
        });
    };

    const finish = (admittedGen: number, failed: boolean, error?: unknown): void => {
        writing = false;
        inFlight = undefined;
        if (overflow !== undefined) {
            const cause = overflow;
            overflow = undefined;
            options.onRejected(cause);
            return;
        }
        if (generation !== admittedGen) {
            kick();
            return;
        }
        if (failed) {
            pending.length = 0;
            pendingChars = 0;
            options.onRejected(error);
            return;
        }
        kick();
    };

    return {
        push: (frame) => {
            if (overflow !== undefined) return;
            if (pending.length >= maxPendingFrames || pendingChars + frame.bytes.length > maxPendingChars) {
                pending.length = 0;
                pendingChars = 0;
                if (scheduled !== undefined) {
                    options.cancelSchedule(scheduled);
                    scheduled = undefined;
                }
                const cause = new Error('Terminal write backlog exceeded; a fresh repaint is required');
                if (writing) overflow = cause;
                else options.onRejected(cause);
                return;
            }
            pending.push(frame);
            pendingChars += frame.bytes.length;
            kick();
        },
        cancel: () => {
            generation += 1;
            if (scheduled !== undefined) {
                options.cancelSchedule(scheduled);
                scheduled = undefined;
            }
            pending.length = 0;
            pendingChars = 0;
            overflow = undefined;
            return inFlight ?? Promise.resolve();
        },
    };
}
