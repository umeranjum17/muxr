import { fail, ok, unwrapOrThrow, type Outcome } from '../../shared/outcome.js';
import type { ClientFrame } from '../domain/envelope.js';

/** Admit an untrusted client frame before host code reads request fields. */
export function admitClientFrame(command: { frame: unknown }): Outcome<ClientFrame> {
    const value = command.frame;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('client frame must be an object');
    const frame = value as Record<string, unknown>;
    if (typeof frame.type !== 'string' || frame.type === '' || frame.type.length > 80) return fail('client frame type is invalid');
    if (frame.type === 'client.hello') {
        if (typeof frame.clientId !== 'string' || frame.clientId === '' || frame.clientId.length > 160) {
            return fail('client hello is invalid');
        }
        return ok(value as ClientFrame);
    }
    const requestIdIsInvalid = typeof frame.requestId !== 'string' || frame.requestId === '' || frame.requestId.length > 160;
    const paramsAreInvalid = typeof frame.params !== 'object' || frame.params === null || Array.isArray(frame.params);
    if (requestIdIsInvalid || paramsAreInvalid) return fail('client request shape is invalid');
    return ok(value as ClientFrame);
}

export function tryParseClientFrame(value: unknown): Outcome<ClientFrame> {
    return admitClientFrame({ frame: value });
}

export function parseClientFrame(value: unknown): ClientFrame {
    return unwrapOrThrow(admitClientFrame({ frame: value }));
}
