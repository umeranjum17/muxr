import { MOVE_CONTINUE_NOTE, type MoveOffer } from '@trymuxr/contract';

/**
 * What one agent kind adds to the shared move core: which provider's sign-in
 * folder holds its conversations on the destination. Everything else (export,
 * courier, import, resume) is shared. A kind with no adapter keeps Continue.
 */
export interface MoveAdapter {
    kind: string;
    provider: 'claude';
}

const ADAPTERS: readonly MoveAdapter[] = [{ kind: 'claude', provider: 'claude' }];

export function moveAdapter(kind: string | undefined): MoveAdapter | undefined {
    return ADAPTERS.find((adapter) => adapter.kind === kind);
}

export function moveOffer(kind: string | undefined): MoveOffer {
    return moveAdapter(kind) === undefined ? { movable: false, note: MOVE_CONTINUE_NOTE } : { movable: true, kind: kind! };
}

export function moveError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}
