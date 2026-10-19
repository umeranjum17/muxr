import { getWebSecret, listWebSecretNames } from '../pairing/infrastructure/webSecureStore';
import { isOpenableNotifyUrl, openLifecycleNotice } from './openLifecycleNotice';

declare const self: {
    openLifecyclePush: (payload: unknown) => Promise<ReturnType<typeof openLifecycleNotice>>;
    // The same link acceptance the native tap applies, so a web tap opens exactly what native does.
    isOpenableNoticeUrl: typeof isOpenableNotifyUrl;
};

self.isOpenableNoticeUrl = isOpenableNotifyUrl;

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
