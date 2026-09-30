import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostedAccountUxPattern } from './hostedAccountUxPattern.mjs';

describe('hosted-account route guard', () => {
    it('allows plans routes and rejects the removed hosted-account route', () => {
        const app = mkdtempSync(join(process.cwd(), '.commerce-routes-'));
        try {
            const settings = join(app, '(app)', 'settings');
            mkdirSync(settings, { recursive: true });
            writeFileSync(join(settings, 'accounts.tsx'), 'export default function Accounts() {}');
            expect(() => hostedAccountUxPattern(app)).not.toThrow();
            writeFileSync(join(settings, 'account.tsx'), 'export default function Account() {}');
            expect(() => hostedAccountUxPattern(app)).toThrow('still exposes hosted-account UX');
            rmSync(join(settings, 'account.tsx'));
            mkdirSync(join(settings, 'account'));
            writeFileSync(join(settings, 'account', 'index.tsx'), 'export default function Account() {}');
            expect(() => hostedAccountUxPattern(app)).toThrow('still exposes hosted-account UX');
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });
});
