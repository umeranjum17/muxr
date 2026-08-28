import type { Ionicons } from '@expo/vector-icons';
import type { AttentionReason } from '@muxr/contract';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

type Theme = ReturnType<typeof useUnistyles>['theme'];

/** Shared by the inbox and the bell so the two surfaces cannot drift apart. */
export function attentionPresentation(
    reason: AttentionReason,
    theme: Theme,
): { icon: React.ComponentProps<typeof Ionicons>['name']; color: string; label: string } {
    switch (reason) {
        case 'waiting':
            return { icon: 'help-circle', color: theme.colors.warningCritical, label: t('inbox.reason.waiting') };
        case 'blocked':
            return { icon: 'hand-left', color: theme.colors.textDestructive, label: t('inbox.reason.blocked') };
        case 'failed':
            return { icon: 'alert-circle', color: theme.colors.textDestructive, label: t('inbox.reason.failed') };
        case 'done':
            return { icon: 'checkmark-circle', color: theme.colors.success, label: t('inbox.reason.done') };
        // A host on an older build can name a reason this app no longer has.
        // Render it plainly rather than taking the whole inbox down.
        default:
            return { icon: 'ellipse', color: theme.colors.textSecondary, label: String(reason) };
    }
}
