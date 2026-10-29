import { Accounts, browserStore, portable } from '@byokit/accounts';
import { PHONE_MEMBER } from '../domain/phone';

const authBase = process.env.EXPO_PUBLIC_MUXR_PHONE_AUTH_BASE || undefined;
const apiBase = process.env.EXPO_PUBLIC_MUXR_PHONE_API_BASE || undefined;

/** In the installed PWA the sign-in lives in the browser's own IndexedDB. */
export function phoneAccounts() {
    return new Accounts({
        store: (member) => browserStore(`byokit.${member}`),
        app: 'muxr',
        authBase,
        apiBase,
    }, portable);
}
