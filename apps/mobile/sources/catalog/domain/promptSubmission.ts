import { HOST_CAPABILITY_PROMPT_RECEIPTS } from '@muxr/contract';

export const UNSUPPORTED_HOST = 'This computer runs an older muxr that cannot confirm a message runs only once. Update muxr on the computer, then send again.';

/** Whether the paired computer keeps prompt receipts; without them no resend is safe to promise. */
export function hostConfirmsPromptsRunOnce(capabilities: readonly string[] | undefined): boolean {
    return capabilities?.includes(HOST_CAPABILITY_PROMPT_RECEIPTS) === true;
}
