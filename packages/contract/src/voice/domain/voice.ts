/**
 * Realtime voice as product state.
 *
 * These shapes are the app-facing surface of `apps/host/src/voice`. The
 * provider adapters stay internal and swappable; the app only ever sees a
 * provider entry, its readiness, and the setup screen that configures it.
 */
export interface VoiceProviderEntry {
    id: string;
    name: string;
    description: string;
    /** Native setup surface this provider needs; never a plugin screen id. */
    setup: 'api-key' | 'codex-login';
    selected: boolean;
    stateLabel: string;
}

export interface VoiceProviderCatalog {
    selected: string;
    providers: VoiceProviderEntry[];
}

/** One engine's explainer card: what it is, whether it is in use, and whether it is ready. */
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

/** One agent-stop outcome the provider may speak unprompted. */
export interface VoiceReport {
    say: string;
}
