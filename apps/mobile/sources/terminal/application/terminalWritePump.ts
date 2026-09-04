/**
 * Single-flight native terminal writer. A pending graphics:true full snapshot
 * supersedes earlier pending draw/delete graphics because it self-clears.
 * A graphics:false frame is appended in order — it may be targeted d=i or
 * full d=A — so a retire still runs after a pending draw. Text stays ordered.
 * Graphics is never decoded or combined with text.
 */

export type TerminalWriteFrame = {
    bytes: string;
    graphics?: boolean;
};

export type TerminalWritePump = {
    push: (frame: TerminalWriteFrame) => void;
    cancel: () => Promise<void>;
};

export function createTerminalWritePump(options: {
    write: (bytes: string, graphics?: boolean) => Promise<unknown>;
    combineText: (frames: readonly string[]) => string;
    schedule: (run: () => void) => unknown;
    cancelSchedule: (handle: unknown) => void;
    onRejected: (error: unknown) => void;
}): TerminalWritePump {
    const pending: TerminalWriteFrame[] = [];
    let generation = 0;
    let writing = false;
    let scheduled: unknown;
    let inFlight: Promise<void> | undefined;

    const nextPayload = (): TerminalWriteFrame | undefined => {
        if (pending.length === 0) return undefined;
        const head = pending[0]!;
        if (typeof head.graphics === 'boolean') {
            pending.shift();
            return head;
        }
        const texts: string[] = [];
        while (pending.length > 0 && typeof pending[0]!.graphics !== 'boolean') {
            texts.push(pending.shift()!.bytes);
        }
        if (texts.length === 0) return undefined;
        return { bytes: texts.length === 1 ? texts[0]! : options.combineText(texts) };
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
            const admitted = Promise.resolve().then(() => options.write(payload.bytes, payload.graphics));
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
        if (generation !== admittedGen) {
            kick();
            return;
        }
        if (failed) {
            pending.length = 0;
            options.onRejected(error);
            return;
        }
        kick();
    };

    return {
        push: (frame) => {
            if (frame.graphics === true) {
                for (let index = pending.length - 1; index >= 0; index--) {
                    if (typeof pending[index]!.graphics === 'boolean') pending.splice(index, 1);
                }
            }
            pending.push(frame);
            kick();
        },
        cancel: () => {
            generation += 1;
            if (scheduled !== undefined) {
                options.cancelSchedule(scheduled);
                scheduled = undefined;
            }
            pending.length = 0;
            return inFlight ?? Promise.resolve();
        },
    };
}
