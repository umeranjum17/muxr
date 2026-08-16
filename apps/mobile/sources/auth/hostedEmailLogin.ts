import { randomUUID } from 'expo-crypto';
import { relayControlUrl } from '@muxr/contract';
import { DEFAULT_CONNECTION } from '@/state/connectionSettings';
import { getOrCreateHostedDeviceKey } from '@/state/hostedE2ee';
import { firstRestorableMachine } from '@/commercialization';

interface EmailLoginFlow {
    base: string;
    email: string;
    userCode: string;
}

async function post(base: string, path: string, body: unknown): Promise<Record<string, any>> {
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(String(result.error ?? `request failed (${response.status})`));
    return result;
}

/** Email authenticates the account/device only; no machine key or grant is returned. */
export async function startHostedEmailLogin(email: string): Promise<EmailLoginFlow> {
    const base = relayControlUrl(DEFAULT_CONNECTION.relayUrl);
    const key = await getOrCreateHostedDeviceKey();
    const authorization = await post(base, '/v1/device-authorizations', {
        machine_slug: `mobile-login-${randomUUID()}`,
        machine_name: 'Mobile account login (no machine access)',
        machine_public_key: key.publicKey,
        platform: 'mobile-login',
        cli_version: '0.1.0',
    });
    await post(base, '/v1/auth/email/start', { email, user_code: authorization.user_code });
    return { base, email, userCode: authorization.user_code };
}

export async function finishHostedEmailLogin(flow: EmailLoginFlow, code: string): Promise<{ token: string; secret: string; machineId?: string }> {
    const key = await getOrCreateHostedDeviceKey();
    const verified = await post(flow.base, '/v1/auth/email/verify', {
        email: flow.email,
        user_code: flow.userCode,
        code,
        device_public_key: key.publicKey,
        device_kind: 'mobile',
        device_name: 'muxr mobile',
    });
    if (typeof verified.access_token !== 'string') throw new Error('email login returned no device credential');
    const machinesResponse = await fetch(`${flow.base}/v1/machines`, {
        headers: { authorization: `Bearer ${verified.access_token}` },
    });
    const machines = machinesResponse.ok
        ? (await machinesResponse.json() as { machines?: Array<{ id?: unknown; paired?: unknown }> }).machines ?? []
        : [];
    const machineId = firstRestorableMachine(machines);
    return {
        token: verified.access_token,
        secret: key.secretKey,
        ...(machineId === undefined ? {} : { machineId }),
    };
}
