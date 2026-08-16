/*
 * `/usage` lives in a Pi plugin that answers with a chat message, so running
 * it in the open session would spend that session's context on the reply. A
 * throwaway `--no-session` process answers the same question and writes nothing.
 *
 * `< /dev/null` is load-bearing: print mode reads stdin, and the host runs this
 * through a pipe, so without it Pi blocks until the request times out.
 */
export const USAGE_COMMAND =
    'pi --print --mode json --no-session --no-tools --no-skills -np --no-context-files /quota < /dev/null';

/** Pulls the plugin's reply out of Pi's JSON event stream. */
export function parseUsageOutput(stdout: string): string | undefined {
    for (const line of stdout.split('\n').reverse()) {
        if (!line.startsWith('{')) continue;
        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        const message = (event as { message?: { customType?: unknown; content?: unknown } }).message;
        if (message?.customType !== 'subscription-usage') continue;
        if (typeof message.content === 'string' && message.content.trim() !== '') return message.content;
    }
    return undefined;
}
