import { useUpdates } from '@/hooks/useUpdates';
import { useAttentionEntries } from '@/catalog/store';
import { useChangelog } from '@/changelog';

/** Tab dot: a session needs you, an app update, or an unread changelog entry. */
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const changelog = useChangelog();
    const attention = useAttentionEntries();

    return updateAvailable || changelog.hasUnread === true || attention.length > 0;
}
