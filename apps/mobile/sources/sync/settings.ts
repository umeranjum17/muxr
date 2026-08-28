import * as z from 'zod';

export const SUPPORTED_SCHEMA_VERSION = 2;

export const SettingsSchema = z.object({
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION),
    avatarStyle: z.string().describe('Avatar display style'),
    showFlavorIcons: z.boolean().describe('Whether to show AI provider icons in avatars'),
    hideInactiveSessions: z.boolean().describe('Hide inactive sessions in the main list'),
    sortSessionsByActivity: z.boolean().describe('Sort the session list by last activity instead of creation date'),
    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
});

const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    avatarStyle: 'brutalist',
    showFlavorIcons: false,
    hideInactiveSessions: true,
    sortSessionsByActivity: false,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    preferredLanguage: null,
};
Object.freeze(settingsDefaults);

export function settingsParse(settings: unknown): Settings {
    if (!settings || typeof settings !== 'object') {
        return { ...settingsDefaults };
    }
    const parsed = SettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...settingsDefaults };
    }
    return { ...settingsDefaults, ...parsed.data };
}

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    const result = { ...settings, ...delta };
    for (const key of Object.keys(settingsDefaults) as Array<keyof Settings>) {
        if (!(key in result)) {
            (result as Settings)[key] = settingsDefaults[key] as never;
        }
    }
    return result;
}
