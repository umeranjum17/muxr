import { LIFECYCLE_NOTIFICATION_LEVELS } from '@muxr/contract';
import * as z from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    consoleLoggingEnabled: z.boolean().describe('Enable console output in production builds'),
    verboseLogging: z.boolean().describe('Log all network requests and responses'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    promotedNotificationsPrompted: z.boolean().describe('Whether Android Live Updates access was already explained'),
    backgroundConnectionPrompted: z.boolean().describe('Whether Android background activity settings were already explained'),
    terminalKeyboardDisabled: z.boolean().describe('Disable opening the Android terminal keyboard when tapping its surface'),
    vadStandbyEnabled: z.boolean().describe('Persistently wake realtime voice from local speech activity standby'),
    terminalScreenReader: z.boolean().describe('Expose terminal output to screen readers (web xterm screenReaderMode)'),
    terminalFontSize: z.union([z.literal(11), z.literal(12), z.literal(13), z.literal(14), z.literal(16), z.literal(18)]).describe('Browser terminal font size in px'),
    lifecycleNotificationLevel: z.enum(LIFECYCLE_NOTIFICATION_LEVELS).describe('Which agent lifecycle events may emit notifications'),
    // Herd tab: bucket the agents section under workspace subheaders (herdr's "grouped" toggle).
    // Saved herdr tab layouts (split tree + agent kind per pane), newest first.
    savedLayouts: z
        .array(z.object({ name: z.string(), snapshot: z.unknown() }))
        .describe('Saved herdr layouts, newest first'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

/** The sizes the terminal text-size sheet offers; 13 is what it always was. */
export const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 16, 18] as const;

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    devModeEnabled: false,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    promotedNotificationsPrompted: false,
    backgroundConnectionPrompted: false,
    terminalKeyboardDisabled: false,
    vadStandbyEnabled: false,
    terminalScreenReader: false,
    terminalFontSize: 13,
    lifecycleNotificationLevel: 'important',
    savedLayouts: [],
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    // The old flag had the opposite meaning. Ignore it rather than turning an
    // old `false` into a new disable, which would preserve the broken default.
    const { terminalAutoShowKeyboard: _legacy, ...current } = parsed.data as typeof parsed.data & {
        terminalAutoShowKeyboard?: unknown;
    };
    return { ...localSettingsDefaults, ...current };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
