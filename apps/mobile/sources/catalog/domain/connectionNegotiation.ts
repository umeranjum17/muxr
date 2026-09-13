import { HOST_CAPABILITY_PROMPT_RECEIPTS } from '@muxr/contract';

export const UNSUPPORTED_HOST = 'This computer runs an older muxr that cannot confirm a message runs only once. Update muxr on the computer, then send again.';

/** Whether the paired computer keeps prompt receipts; without them no resend is safe to promise. */
export function hostConfirmsPromptsRunOnce(capabilities: readonly string[] | undefined): boolean {
    return capabilities?.includes(HOST_CAPABILITY_PROMPT_RECEIPTS) === true;
}

/**
 * What the connected host advertised, bound to the exact transport object and
 * connection epoch it was learned on. Every close, stale route or transport
 * replacement is a new epoch; a catalog answer from an older epoch is stale
 * and never recorded; a prompt needs support negotiated on the connection
 * that will carry it.
 */
export class ConnectionNegotiation<Client extends object> {
    private epoch = 0;
    private negotiated: { client: Client; epoch: number; capabilities: readonly string[] | undefined } | undefined;

    /** The connection changed (closed, stale, replaced): nothing is negotiated any more. */
    invalidate(): number {
        this.epoch += 1;
        this.negotiated = undefined;
        return this.epoch;
    }

    get current(): number {
        return this.epoch;
    }

    /** Record what a catalog answer learned, unless the connection moved on meanwhile. */
    record(client: Client, epoch: number, capabilities: readonly string[] | undefined): boolean {
        if (epoch !== this.epoch) return false;
        this.negotiated = { client, epoch, capabilities };
        return true;
    }

    /** Capabilities negotiated on this exact client and epoch, else undefined. */
    capabilitiesFor(client: Client, epoch = this.epoch): readonly string[] | undefined {
        const known = this.negotiated;
        if (known === undefined || known.client !== client || known.epoch !== epoch || epoch !== this.epoch) return undefined;
        return known.capabilities;
    }

    isNegotiated(client: Client): boolean {
        return this.negotiated !== undefined && this.negotiated.client === client && this.negotiated.epoch === this.epoch;
    }
}
