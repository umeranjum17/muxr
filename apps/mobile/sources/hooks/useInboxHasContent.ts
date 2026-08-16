import { useUpdates } from './useUpdates';
import { useAttentionEntries } from '@/sync/storage';
import { useChangelog } from './useChangelog';

/** Tab dot: a session needs you, an app update, or an unread changelog entry. */
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();
    const changelog = useChangelog();
    const attention = useAttentionEntries();

    return updateAvailable || changelog.hasUnread === true || attention.length > 0;
}
