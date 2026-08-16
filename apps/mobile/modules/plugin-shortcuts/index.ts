import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

export type NativePluginShortcut = { id: string; label: string; longLabel: string };

interface PluginShortcutsNative {
    setShortcuts: (shortcuts: NativePluginShortcut[], bakedIds: string[]) => boolean;
}

const native = Platform.OS === 'android'
    ? requireOptionalNativeModule<PluginShortcutsNative>('PluginShortcuts')
    : null;

/** Native projection is best-effort and can never block catalog freshness. */
export function setPluginShortcuts(shortcuts: NativePluginShortcut[], bakedIds: string[]): boolean {
    try {
        return native?.setShortcuts(shortcuts, bakedIds) ?? true;
    } catch {
        return false;
    }
}
