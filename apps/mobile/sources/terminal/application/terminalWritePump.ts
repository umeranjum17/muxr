/**
 * Single-flight native terminal writer. Graphics records may change independent
 * placements or delete a specific earlier image, so all stay in wire order.
 * Only adjacent plain text is combined. A bounded backlog fails explicitly and
 * requests a repaint after the admitted native write has settled.
 */

export type TerminalWriteFrame = {
    bytes: string;
    graphics?: boolean;
    /**
     * The scroll request this frame answers. It travels with the payload so a
     * latency is only recorded when the write that carries the answer settles,
     * never when some unrelated or older output happens to arrive first.
     */
    mark?: number;
};

export type TerminalWritePump = {
    push: (frame: TerminalWriteFrame) => void;
    cancel: () => Promise<void>;
};

export function createTerminalWritePump(options: {
    write: (bytes: string, graphics?: boolean, mark?: number) => Promise<unknown>;
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

    const nextPayload = (): TerminalWriteFrame | undefined => {
        if (pending.length === 0) return undefined;
        const head = pending[0]!;
        if (typeof head.graphics === 'boolean') {
            pending.shift();
            pendingChars -= head.bytes.length;
            return head;
        }
        const texts: string[] = [];
        // Combining must not lose the answer: the earliest marked frame in the
        // run is the one that answered, and the combined write carries it.
        let mark: number | undefined;
        while (pending.length > 0 && typeof pending[0]!.graphics !== 'boolean') {
            const next = pending.shift()!;
            pendingChars -= next.bytes.length;
            texts.push(next.bytes);
            if (mark === undefined) mark = next.mark;
        }
        if (texts.length === 0) return undefined;
        return { bytes: texts.length === 1 ? texts[0]! : options.combineText(texts), ...(mark === undefined ? {} : { mark }) };
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
            const admitted = Promise.resolve().then(() => options.write(payload.bytes, payload.graphics, payload.mark));
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
