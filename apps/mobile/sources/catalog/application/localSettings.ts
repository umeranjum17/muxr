import { LIFECYCLE_NOTIFICATION_LEVELS } from '@muxr/contract';
import * as z from 'zod';
import { DEFAULT_FONT_INDEX, FONT_STEPS } from '../../terminal/domain/fontSteps';
import { TERMINAL_KEY_ROW_LIMIT } from '../../terminal/domain/keyRow';

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
    keepScreenAwakeWhileWatching: z.boolean().describe('Keep the screen awake while viewing a working agent'),
    reopenLastTerminal: z.boolean().describe('Reopen the last accessible terminal when the app launches'),
    lastTerminal: z.object({ machineId: z.string(), sessionId: z.string() }).nullable().describe('Last terminal viewed on this device'),
    terminalFontIndex: z.number().int().min(0).max(FONT_STEPS.length - 1).catch(DEFAULT_FONT_INDEX).describe('Terminal text size as an index into FONT_STEPS'),
    // Customised key row: catalog ids plus inline custom keys. Null follows the
    // built-in default row.
    terminalKeyRow: z.array(z.union([z.string(), z.object({
        label: z.string().min(1).max(12),
        send: z.string().min(1).max(512),
        repeat: z.boolean().optional(),
    })])).max(TERMINAL_KEY_ROW_LIMIT).nullable().catch(null).describe('Customised terminal key row (null follows the built-in row)'),
    // Terminal command puck and its open panel rest where the person drags
    // them, as fractions of the terminal surface's travel range.
    terminalCommandKeyDock: z.object({ fx: z.number(), fy: z.number() }).nullable().describe('Where the floating terminal command puck rests, as fractions of the terminal surface'),
    terminalPanelDock: z.object({ fx: z.number(), fy: z.number() }).nullable().describe('Where the floating terminal command panel was last placed, as fractions of the terminal surface'),
    vadStandbyEnabled: z.boolean().describe('Persistently wake realtime voice from local speech activity standby'),
    dictationLanguage: z.string().nullable().describe('Spoken dictation language (null for automatic detection)'),
    dictationModel: z.string().describe('Selected on-device dictation model'),
    dictationWordReplacements: z.array(z.object({ from: z.string(), to: z.string() })).describe('On-device dictation word replacements'),
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
    keepScreenAwakeWhileWatching: true,
    reopenLastTerminal: true,
    lastTerminal: null,
    terminalFontIndex: DEFAULT_FONT_INDEX,
    terminalKeyRow: null,
    terminalCommandKeyDock: null,
    terminalPanelDock: null,
    vadStandbyEnabled: false,
    dictationLanguage: null,
    dictationModel: 'base.en-q5_1',
    dictationWordReplacements: [],
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
