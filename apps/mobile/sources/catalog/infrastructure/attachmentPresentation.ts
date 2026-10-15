/**
 * How a prompt attachment reads in the composer before it is sent: a short
 * size label and a file-type icon. Images render their own thumbnail, so these
 * cover everything that is not an image.
 */
import { Ionicons } from '@expo/vector-icons';
import type { AttachmentPreview } from './attachmentTypes';

type IconName = keyof typeof Ionicons.glyphMap;

/** Extension is the only signal we have for most binaries; mimeType as a fallback. */
export function attachmentIcon(attachment: Pick<AttachmentPreview, 'name' | 'mimeType'>): IconName {
    const extension = attachment.name.includes('.')
        ? attachment.name.slice(attachment.name.lastIndexOf('.') + 1).toLowerCase()
        : '';
    if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'].includes(extension)) return 'file-tray-full-outline';
    if (extension === 'pdf') return 'document-text-outline';
    if (['txt', 'md', 'json', 'csv', 'log', 'yml', 'yaml', 'xml', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(extension)) return 'document-outline';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(extension)) return 'videocam-outline';
    if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(extension)) return 'musical-notes-outline';
    if (['xls', 'xlsx', 'numbers'].includes(extension)) return 'grid-outline';
    if (['doc', 'docx', 'pages', 'rtf'].includes(extension)) return 'document-text-outline';
    return 'document-attach-outline';
}

export function attachmentSizeLabel(size: number): string {
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    if (size > 0) return `${size} B`;
    return '';
}
