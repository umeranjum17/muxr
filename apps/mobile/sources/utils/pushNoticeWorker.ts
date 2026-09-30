import { getWebSecret, listWebSecretNames } from '../pairing/infrastructure/webSecureStore';
import { openLifecycleNotice } from './openLifecycleNotice';

declare const self: { openLifecyclePush: (payload: unknown) => Promise<ReturnType<typeof openLifecycleNotice>> };

self.openLifecyclePush = async (payload) => {
    try {
        const names = (await listWebSecretNames()).filter((name) => name.startsWith('muxr.grant.'));
        const grants = await Promise.all(names.map(async (name) => {
            const raw = await getWebSecret(name);
            return raw === null ? undefined : JSON.parse(raw);
        }));
        return openLifecycleNotice(payload, grants.filter((grant) => grant !== undefined));
    } catch {
        return openLifecycleNotice(payload, []);
    }
};
