import { relayControlUrl } from '@muxr/contract';
import { DEFAULT_CONNECTION } from '../state/connectionSettings';

export function getServerUrl(): string {
    return relayControlUrl(DEFAULT_CONNECTION.relayUrl);
}

export function setServerUrl(_url: string | null): void {}

export function getLogServerUrl(): string | null {
    return null;
}

export function setLogServerUrl(_url: string | null): void {}

export function isUsingCustomServer(): boolean {
    return false;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    try {
        const parsed = new URL(getServerUrl());
        return {
            hostname: parsed.hostname,
            port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
            isCustom: false,
        };
    } catch {
        return { hostname: '127.0.0.1', port: 8792, isCustom: false };
    }
}

export function validateServerUrl(_url: string): { valid: boolean; error?: string } {
    return { valid: true };
}
