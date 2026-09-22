import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
export async function loadPreviewRuntime(): Promise<string> {
    const asset = Asset.fromModule(require('./preview.bundle.bin'));
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('Offline preview renderer unavailable.');
    return new File(asset.localUri).text();
}
