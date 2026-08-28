import { timingSafeEqual } from 'node:crypto';

export function secureEqual(expected: string, provided: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
}
