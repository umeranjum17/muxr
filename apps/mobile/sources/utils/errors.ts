export class ActionError extends Error {
    readonly canTryAgain: boolean;

    constructor(message: string, canTryAgain: boolean) {
        super(message);
        this.canTryAgain = canTryAgain;
        this.name = 'RetryableError';
        Object.setPrototypeOf(this, ActionError.prototype);
    }
}

export type HumanError = { title: string; message: string; details?: string };

const HUMAN_ERRORS: Array<[RegExp, HumanError]> = [
    [/unsupported in demo replay/i, { title: 'Not available in the demo', message: 'Not available in the demo. Pair your computer to use it for real.' }],
    [/may already have reached the agent/i, { title: 'Maybe already sent', message: 'This message may already have reached the agent: the computer restarted while sending it. Check the terminal before sending it again.' }],
    [/timed out|no reply from machine|timeout/i, { title: 'No answer', message: "Your computer didn't answer. Check the connection, then try again." }],
    [/grant expired/i, { title: 'Access expired', message: "This browser's access expired. Pair again to continue." }],
    [/revoked/i, { title: 'Access removed', message: 'This device was removed from the machine. Pair again to continue.' }],
    [/not a git repository/i, { title: 'Not a Git repository', message: "This folder isn't a Git repository, so there are no changes to show." }],
    [/no such (file or )?directory|ENOENT|ENOTDIR|not a directory/i, { title: 'Folder not found', message: "That folder doesn't exist on the machine. Pick another one." }],
];

/**
 * One sentence a person would say, then one action. The raw text rides along
 * as `details` for a disclosure or diagnostics; it is never the headline.
 */
export function humanError(cause: unknown): HumanError {
    let raw = String(cause ?? '');
    if (cause instanceof Error) raw = cause.message;
    for (const [pattern, human] of HUMAN_ERRORS) {
        if (pattern.test(raw)) return { ...human, details: raw };
    }
    return { title: 'Something went wrong', message: "That didn't work. Try again in a moment.", details: raw || undefined };
}

/**
 * The human sentence when one exists; otherwise the raw cause, since a bare
 * "try again" hides the one detail that would let the person fix it.
 */
export function failureText(cause: unknown): string {
    const human = humanError(cause);
    return human.title === 'Something went wrong' && human.details ? human.details.replace(/`/g, '') : human.message;
}
