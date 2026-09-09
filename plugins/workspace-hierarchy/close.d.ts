export function herdrErrorCode(error: unknown): string | undefined;
export function isGoneHerdr(error: unknown): boolean;
export function isRetryableHerdr(error: unknown): boolean;
export function isNoWidenHerdr(error: unknown): boolean;
export function closeAgent(options: {
    paneId: string;
    confirmedScope?: 'tab' | 'workspace' | 'worktreeGroup';
    call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}): Promise<
    | { status: 'closed'; alreadyGone?: true }
    | { status: 'confirmationRequired'; scope: 'tab' | 'workspace' | 'worktreeGroup'; label: string; message: string }
    | { status: 'retryable'; message: string }
>;
export function createSocketCall(
    socketPath?: string,
    timeoutMs?: number,
): (method: string, params?: Record<string, unknown>) => Promise<unknown>;
