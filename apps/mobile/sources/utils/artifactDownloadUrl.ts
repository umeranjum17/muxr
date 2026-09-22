import { getCachedConnectionSettings } from '@/connection';
import { relayControlUrl } from '@muxr/contract';
import type { StoredSessionArtifact } from '@/catalog/application/persistence';

/**
 * Plain HTTPS GET for an artifact's original bytes. Anything over 32MiB is
 * refused by the ws fetch path (base64 of a 250MB file OOM-crashed the host),
 * so both web and native download through the relay instead.
 *
 * The route and its query keys are deliberately frozen at the pre-rename
 * spelling. This URL is handed to the OS download manager and to a browser
 * anchor, neither of which can fall back on a failure, and an app built after
 * the artifact rename still has to reach a relay built before it. The artifact
 * vocabulary here lives in the code; the URL stays what the relay already
 * serves. The relay reads both spellings, so it can move first when every
 * installed app is past the rename.
 */
export function artifactDownloadUrl(sessionId: string, artifact: StoredSessionArtifact): string {
    const settings = getCachedConnectionSettings();
    const base = relayControlUrl(settings.relayUrl);
    const query = new URLSearchParams({
        machineId: settings.machineId,
        sessionId,
        attachmentId: artifact.id,
        token: settings.token,
    });
    return `${base}/v1/attachment-download?${query.toString()}`;
}
