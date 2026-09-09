import type { PluginScreenTone } from '@muxr/contract';
import type { Theme } from '@/theme';

/**
 * One tone-to-colour mapping for every plugin surface. Four private copies had
 * drifted far enough that `warning` was amber on a declarative screen and blue
 * in the sheet rendering the same plugin's data.
 */
export function toneColor(theme: Theme, tone: PluginScreenTone | undefined): string {
    switch (tone) {
        case 'positive': return theme.colors.status.done;
        case 'warning': return theme.colors.box.warning.text;
        case 'danger': return theme.colors.status.error;
        case 'primary': return theme.colors.accent;
        default: return theme.colors.textSecondary;
    }
}
