import { getCachedConnectionSettings } from '@/connection';
import { relayControlUrl } from '@muxr/contract';
import type { StoredSessionAttachment } from '@/catalog/application/persistence';

/**
 * Plain HTTPS GET for an attachment's original bytes. Anything over 32MiB is
 * refused by the ws fetch path (base64 of a 250MB file OOM-crashed the host),
 * so both web and native download through the relay instead.
 */
export function attachmentDownloadUrl(sessionId: string, attachment: StoredSessionAttachment): string {
    const settings = getCachedConnectionSettings();
    const base = relayControlUrl(settings.relayUrl);
    const query = new URLSearchParams({
        machineId: settings.machineId,
        sessionId,
        attachmentId: attachment.id,
        token: settings.token,
    });
    return `${base}/v1/attachment-download?${query.toString()}`;
}
