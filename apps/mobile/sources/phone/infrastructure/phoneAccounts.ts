import * as SecureStore from 'expo-secure-store';
import { fetch as streamingFetch } from 'expo/fetch';
import { Accounts, portable, secureStore } from '@byokit/accounts';
import { PHONE_MEMBER } from '../domain/phone';

// Lab builds point sign-in and answers at a stand-in (the Boat lab does the same); a release leaves both empty.
const authBase = process.env.EXPO_PUBLIC_MUXR_PHONE_AUTH_BASE || undefined;
const apiBase = process.env.EXPO_PUBLIC_MUXR_PHONE_API_BASE || undefined;

/** The sign-in lives in this phone's secure storage; muxr runs nothing of its own in between. */
export function phoneAccounts() {
    return new Accounts({
        store: (member) => secureStore(SecureStore, `byokit.${member}`),
        fetch: streamingFetch as unknown as typeof fetch,
        app: 'muxr',
        authBase,
        apiBase,
    }, portable);
}

