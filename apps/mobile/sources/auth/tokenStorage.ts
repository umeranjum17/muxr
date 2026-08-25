import { Platform } from 'react-native';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from '@/state/nativeSecretStore';
import { deleteWebSecret, getWebSecret, setWebSecret } from '@/state/webSecureStore';

const AUTH_KEY = 'auth_credentials';

// Cache for synchronous access
let credentialsCache: string | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            // Delete the pre-release localStorage credential without reading or migrating it.
            if (typeof localStorage !== 'undefined') localStorage.removeItem(AUTH_KEY);
            const stored = await getWebSecret(AUTH_KEY);
            return stored === null ? null : JSON.parse(stored) as AuthCredentials;
        }
        try {
            const stored = await getNativeSecret(AUTH_KEY);
            if (!stored) return null;
            credentialsCache = stored; // Update cache
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        if (Platform.OS === 'web') {
            await setWebSecret(AUTH_KEY, JSON.stringify(credentials));
            return true;
        }
        try {
            const json = JSON.stringify(credentials);
            await setNativeSecret(AUTH_KEY, json);
            credentialsCache = json; // Update cache
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {
            await deleteWebSecret(AUTH_KEY);
            return true;
        }
        try {
            await deleteNativeSecret(AUTH_KEY);
            credentialsCache = null; // Clear cache
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};