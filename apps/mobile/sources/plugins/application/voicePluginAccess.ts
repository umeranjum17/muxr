import type { PluginCatalogEntry } from './pluginStore';

export type VoicePluginAccess<T extends PluginCatalogEntry = PluginCatalogEntry> = {
    status: 'ready' | 'disabled' | 'missing';
    plugin?: T;
};

/** Opening voice settings must not reverse an explicit per-device revoke. */
export function voicePluginFromCatalog<T extends PluginCatalogEntry>(catalog: T[]): VoicePluginAccess<T> {
    const plugin = catalog.find((entry) => entry.summary.capabilities['voice.session'] !== undefined);
    if (plugin === undefined) return { status: 'missing' };
    if (!plugin.summary.approved) return { status: 'disabled', plugin };
    return { status: 'ready', plugin };
}
