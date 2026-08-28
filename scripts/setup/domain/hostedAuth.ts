import { validMachineCrypto } from './machineCrypto.js';
import { accepted, rejected, type Result } from './result.js';

export type HostedAuthReport = { level: 'ok' | 'warn' | 'fail'; detail: string };

export type HostedAuth = {
    complete: boolean;
    pendingValid: boolean;
    expires: number;
    report: () => HostedAuthReport;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    return value as Record<string, unknown>;
}

export function parseHostedAuth(raw: unknown, now = Date.now()): Result<HostedAuth> {
    const auth = asRecord(raw);
    if (auth === undefined) return rejected('hosted auth is missing');
    const machine = asRecord(auth.machine);
    const cryptoOk = validMachineCrypto(machine?.crypto, 'hosted');
    const complete = typeof auth.controlUrl === 'string'
        && typeof auth.relayUrl === 'string'
        && typeof auth.credential === 'string'
        && typeof auth.credentialExpiresAt === 'string'
        && typeof machine?.id === 'string'
        && cryptoOk;
    const expires = complete && typeof auth.credentialExpiresAt === 'string'
        ? Date.parse(auth.credentialExpiresAt)
        : Number.NaN;
    const pending = asRecord(auth.pending);
    const pendingValid = !complete
        && auth.version === 1
        && typeof machine?.id === 'string'
        && cryptoOk
        && typeof pending?.controlUrl === 'string'
        && typeof pending?.deviceCode === 'string'
        && typeof pending?.userCode === 'string'
        && typeof pending?.verificationUri === 'string'
        && typeof pending?.expiresAt === 'string'
        && Number.isFinite(Date.parse(pending.expiresAt))
        && Date.parse(pending.expiresAt) > now;
    return accepted({
        complete,
        pendingValid,
        expires,
        report() {
            const credentialIsLive = complete && Number.isFinite(expires) && expires > now;
            if (credentialIsLive) return { level: 'ok', detail: 'owner-only auth state valid' };
            if (complete) return { level: 'fail', detail: 'credential expired — run `muxr login`' };
            if (pendingValid) return { level: 'warn', detail: 'authorization is incomplete — rerun `muxr setup` to resume it' };
            return { level: 'fail', detail: '~/.muxr/auth.json is incomplete — back it up before moving it aside, then run `muxr login`' };
        },
    });
}
