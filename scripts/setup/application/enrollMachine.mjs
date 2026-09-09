import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    api,
    error,
    print,
    printTerminalQr,
    publicRelayUrl,
    stateDir,
} from '../infrastructure/runtime.mjs';
import {
    cloudflaredAlive,
    readSelfhostState,
    selfhostControlBase,
    selfhostRelayHealthy,
} from '../infrastructure/selfhost.mjs';

export async function enrollMachine() {
    try {
        const state = readSelfhostState();
        if (state?.relayLocation === 'remote' || typeof state?.mintSecret !== 'string') throw new Error('machine management runs on the shared relay server');
        if (!(await selfhostRelayHealthy(state))) throw new Error('shared relay service is not healthy; choose Restart muxr, then try again');
        const base = selfhostControlBase(state);
        const headers = { authorization: `Bearer ${state.mintSecret}` };
        if (state.connectionMode === 'cloudflare' && !cloudflaredAlive(state.ingress)) throw new Error('the Cloudflare tunnel is not running; restore the shared relay before creating enrollment');
        if (!(await selfhostRelayHealthy(state))) throw new Error('the shared relay is not healthy; run `muxr doctor` first');
        const relayUrl = publicRelayUrl(state.relayUrl);
        if (relayUrl === undefined || !relayUrl.startsWith('wss://')) throw new Error('shared relay enrollment requires a public wss:// relay URL');
        const created = await api(base, '/v1/selfhost/enrollments', {
            method: 'POST', headers,
            body: JSON.stringify({ relay_url: relayUrl, ...(state.webEnabled ? { web_url: relayUrl.replace(/^wss/, 'https') } : {}) }),
        });
        if (!created.response.ok) throw new Error(created.body.error || 'could not create enrollment');
        const payload = Buffer.from(JSON.stringify({ v: 1, id: created.body.enrollment_id, claim: created.body.claim,
            relay: created.body.relay_url, expires: Date.now() + Number(created.body.expires_in ?? 300) * 1000,
            ...(typeof created.body.web_url === 'string' ? { web: created.body.web_url } : {}) })).toString('base64url');
        const link = `muxr://enroll?payload=${payload}`;
        print('');
        if (process.stdout.isTTY) await printTerminalQr(link);
        print('Machine enrollment string (single-use, expires in five minutes):');
        print(link);
        const path = join(stateDir(), 'enrollment-link.txt');
        writeFileSync(path, `${link}\n`, { mode: 0o600 });
        print(`  saved exact enrollment string to ${path}`);
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
