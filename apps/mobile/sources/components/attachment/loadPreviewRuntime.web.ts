import { Asset } from 'expo-asset';
export async function loadPreviewRuntime(): Promise<string> {
    const asset = Asset.fromModule(require('./preview.bundle.bin'));
    const response = await fetch(asset.uri);
    if (!response.ok) throw new Error('Offline preview renderer unavailable.');
    return response.text();
}
