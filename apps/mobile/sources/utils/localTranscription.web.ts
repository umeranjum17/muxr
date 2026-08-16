export async function transcribePcm16(_chunks: readonly string[], _hint?: string): Promise<string> {
    throw new Error('On-device dictation is available in the Android and iOS apps.');
}
