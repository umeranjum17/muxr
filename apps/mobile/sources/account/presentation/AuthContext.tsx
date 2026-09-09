import React, { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { relayControlUrl } from '@muxr/contract';
import { TokenStorage, type AuthCredentials } from '../application/tokenStorage';
import { setAccountCredentialRejectedHandler, syncCreate } from '@/catalog/sync';
import { clearPersistence } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { clearHostedE2ee } from '@/pairing/e2ee';
import { unregisterNativePushNotifications } from '@/utils/nativePushNotifications';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    const clearLocalSession = useCallback(async (clearMachineKeys: boolean) => {
        clearPersistence();
        if (clearMachineKeys && getCachedConnectionSettings().mode === 'hosted') {
            try { await clearHostedE2ee(); } catch {}
        }
        await TokenStorage.removeCredentials();
        setCredentials(null);
        setIsAuthenticated(false);
        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch {
                // expected in dev
            }
        }
    }, []);

    const login = useCallback(async (token: string, secret: string) => {
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) throw new Error('Failed to save credentials');
        await syncCreate(newCredentials);
        setCredentials(newCredentials);
        setIsAuthenticated(true);
    }, []);

    const logout = useCallback(async () => {
        const connection = getCachedConnectionSettings();
        if (credentials !== null) await unregisterNativePushNotifications(credentials);
        if (connection.mode === 'hosted' && credentials?.token) {
            try {
                await fetch(relayControlUrl(connection.relayUrl, '/v1/session'), {
                    method: 'DELETE',
                    headers: { authorization: `Bearer ${credentials.token}` },
                });
            } catch {}
        }
        await clearLocalSession(true);
    }, [clearLocalSession, credentials?.token]);

    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout } : null);
    }, [isAuthenticated, credentials, login, logout]);

    useEffect(() => {
        // Expired/revoked account credentials end the session, but the device key
        // and machine grants survive so re-authentication does not require re-pairing.
        setAccountCredentialRejectedHandler(() => { void clearLocalSession(false); });
        return () => setAccountCredentialRejectedHandler(undefined);
    }, [clearLocalSession]);

    return (
        <AuthContext.Provider value={{ isAuthenticated, credentials, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    const context = useContext(AuthContext);
    if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
    return context;
}

let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null): void {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
