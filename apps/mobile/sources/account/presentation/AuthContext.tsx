import React, { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { TokenStorage, type AuthCredentials } from '../application/tokenStorage';
import { sync, syncCreate } from '@/catalog/sync';
import { clearPersistence } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { clearHostedE2ee } from '@/pairing/e2ee';
import { unregisterNativePushNotifications } from '@/utils/nativePushNotifications';
import { unsubscribeWebPush } from '@/utils/pushNotifications';

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
        sync.invalidateCatalog();
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
        if (credentials !== null) await unregisterNativePushNotifications(credentials);
        if (Platform.OS === 'web') await unsubscribeWebPush();
        await clearLocalSession(true);
    }, [clearLocalSession, credentials]);

    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout } : null);
    }, [isAuthenticated, credentials, login, logout]);

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
