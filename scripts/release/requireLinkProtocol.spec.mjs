import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appLinkProtocol, requireLinkProtocol } from './application/requireLinkProtocol.mjs';

it('admits a matching retained CLI, but refuses legacy and ambiguous relay protocols', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'muxr-release-link-'));
    const relayPath = join(scratch, 'package', 'relay.js');
    const tarball = join(scratch, 'candidate.tgz');
    mkdirSync(join(scratch, 'package'));
    const packRelay = (source) => {
        writeFileSync(relayPath, source);
        execFileSync('tar', ['-czf', tarball, '-C', scratch, 'package']);
    };
    try {
        expect(appLinkProtocol()).toBe(1);
        packRelay('writeJson(res, 200, { ok: true });');
        expect(() => requireLinkProtocol(tarball)).toThrow('candidate CLI advertises 0');

        // The matching fixture consumes the actual advertised constant rather
        // than giving the reader a second release-tooling protocol number.
        const relay = readFileSync('apps/relay/src/relay.ts', 'utf8');
        const advertised = relay.match(/\blinkProtocol\s*:\s*\d+\b/)?.[0];
        expect(advertised).toBeDefined();
        packRelay(`writeJson(res, 200, { ${advertised} });`);
        expect(() => requireLinkProtocol(tarball)).not.toThrow();

        packRelay(`writeJson(res, 200, { ${advertised} }); const other = { linkProtocol: ${appLinkProtocol() + 1} };`);
        expect(() => requireLinkProtocol(tarball)).toThrow('ambiguous link protocols');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
