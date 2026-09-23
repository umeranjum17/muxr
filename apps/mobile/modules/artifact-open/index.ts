import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface ArtifactOpenNative {
    open: (contentUri: string, mimeType: string) => boolean;
}

const native = Platform.OS === 'android'
    ? requireOptionalNativeModule<ArtifactOpenNative>('ArtifactOpen')
    : null;

/** Hand a device file to the app Android picks for its type; false when none takes it. */
export function openWithSystem(contentUri: string, mimeType: string): boolean {
    try {
        return native?.open(contentUri, mimeType) ?? false;
    } catch {
        return false;
    }
}
