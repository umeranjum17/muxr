import { LIFECYCLE_NOTIFICATION_LEVELS } from '@muxr/contract';
import * as z from 'zod';
import { DEFAULT_FONT_INDEX, FONT_STEPS } from '../../terminal/domain/fontSteps';
import { TERMINAL_KEY_ROW_LIMIT } from '../../terminal/domain/keyRow';
import { DEFAULT_QUICK_ACTIONS, QUICK_ACTION_LABEL_LIMIT, QUICK_ACTION_LIMIT, QUICK_ACTION_TEXT_LIMIT, type QuickAction } from '../../terminal/domain/quickActions';

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
    // Quick actions: this device's own replies and commands. Null follows the
    // built-in seeds, and an empty list is a deliberate empty list. A malformed
    // list falls back to the seeds rather than stranding the device with none.
    terminalQuickActions: z.array(z.object({
        id: z.string().min(1),
        kind: z.enum(['reply', 'command']),
        label: z.string().min(1).max(QUICK_ACTION_LABEL_LIMIT),
        text: z.string().min(1).max(QUICK_ACTION_TEXT_LIMIT),
    })).max(QUICK_ACTION_LIMIT).nullable().catch(null).describe('Personal terminal quick actions (null follows the built-in seeds)'),
    // Retired with terminalCommandKeyDock: the ring's centre now docks in the
    // composer rail, so there is no drag-rest position to store.
    terminalModifierIcons: z.boolean().describe('Draw ctrl and shift as modifier glyphs in the terminal key row'),
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
    terminalQuickActions: null,
    terminalModifierIcons: false,
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
    const { terminalAutoShowKeyboard: _legacy, terminalQuickReplies: legacyReplies, ...current } = parsed.data as typeof parsed.data & {
        terminalAutoShowKeyboard?: unknown;
        terminalQuickReplies?: unknown;
    };
    const merged = { ...localSettingsDefaults, ...current };
    if (current.terminalQuickActions === undefined) merged.terminalQuickActions = migratedQuickActions(legacyReplies);
    return merged;
}

/**
 * A device that only ever had the old insert-only snippet list keeps exactly
 * what it saw: the three seeds it was shown unconditionally, then its own
 * snippets. Nothing to carry over means the seeds alone, which is the same
 * null every fresh device starts from. Pure, so re-reading settings before the
 * next write lands on the same answer every time.
 */
function migratedQuickActions(legacy: unknown): QuickAction[] | null {
    if (!Array.isArray(legacy) || legacy.length === 0) return null;
    const carried = legacy.flatMap((entry): QuickAction[] => {
        if (entry === null || typeof entry !== 'object') return [];
        const { id, label, text } = entry as { id?: unknown; label?: unknown; text?: unknown };
        if (typeof id !== 'string' || typeof label !== 'string' || typeof text !== 'string') return [];
        if (id === '' || label === '' || text === '') return [];
        return [{ id, kind: 'reply', label, text }];
    });
    if (carried.length === 0) return null;
    return [...DEFAULT_QUICK_ACTIONS, ...carried].slice(0, QUICK_ACTION_LIMIT);
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
