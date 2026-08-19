import { describe, expect, it } from 'vitest';
import { providerRefusal } from './stream.mjs';

/**
 * A close code alone sent someone hunting a version mismatch for an account
 * that had simply run out of credits. The body is the only place that says so.
 */
describe('providerRefusal', () => {
    it('surfaces the provider explanation the close code loses', () => {
        const body = JSON.stringify({
            code: 'The caller does not have permission to execute the specified operation',
            error: 'Your team has either used all available credits or reached its monthly spending limit.',
        });
        expect(providerRefusal(403, body)).toBe(
            'Voice provider refused the connection (HTTP 403): Your team has either used all available credits or reached its monthly spending limit.',
        );
    });

    it('falls back to code when there is no error field', () => {
        expect(providerRefusal(403, JSON.stringify({ code: 'forbidden' })))
            .toBe('Voice provider refused the connection (HTTP 403): forbidden');
    });

    it('falls back to the raw body when it is not JSON', () => {
        expect(providerRefusal(502, '  upstream boom  '))
            .toBe('Voice provider refused the connection (HTTP 502): upstream boom');
    });

    it('still names the status when the body is empty', () => {
        expect(providerRefusal(429, '')).toBe('Voice provider refused the connection (HTTP 429).');
    });
});
