import { Asset } from 'expo-asset';

// The app owns materializing its bundled model; native Whisper needs a local file,
// including in development where Metro initially serves assets over HTTP.
const bundledDictationModel: number = require('@/assets/models/ggml-base.en-q5_1.bin');

export async function getBundledDictationModelUri(): Promise<string> {
    const asset = Asset.fromModule(bundledDictationModel);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('The bundled dictation model is unavailable.');
    return asset.localUri;
}
