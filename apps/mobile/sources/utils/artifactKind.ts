export type ArtifactKind = 'image' | 'video' | 'document' | 'apk' | 'file';

export function artifactKind(name: string, mimeType: string): ArtifactKind {
    const lower = name.toLowerCase();
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (lower.endsWith('.apk') || mimeType === 'application/vnd.android.package-archive') return 'apk';
    if (mimeType.startsWith('text/') || mimeType === 'application/pdf' || /\.(md|pdf|html?|json|csv|log)$/i.test(lower)) return 'document';
    return 'file';
}
