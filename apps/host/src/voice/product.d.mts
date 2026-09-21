export interface VoiceProviderEntry {
    id: string;
    name: string;
    description: string;
    setup: 'api-key' | 'codex-login';
    selected: boolean;
}

export interface VoiceProviderCatalog {
    selected: string;
    providers: VoiceProviderEntry[];
}

export interface VoiceProviderDescription extends VoiceProviderEntry {
    configured: boolean;
    statusLabel: string;
}

export interface VoiceStatus {
    configured: boolean;
    statusLabel: string;
    providerId: string;
    providerName: string;
    keyLabel: string;
}

export function voiceStatus(): Promise<VoiceStatus>;
export function voiceProviderList(): Promise<VoiceProviderCatalog>;
export function voiceProviderSet(providerId: unknown): Promise<VoiceProviderCatalog>;
export function voiceProviderDescribe(id?: unknown): Promise<VoiceProviderDescription>;
export function voiceKeySet(key: unknown, providerId?: unknown): Promise<void>;
export function voiceKeyClear(providerId?: unknown): Promise<void>;
export function voiceReport(input: unknown): { say: string };
