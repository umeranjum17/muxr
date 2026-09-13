import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { TERMINAL_FONT_SIZES } from '@/catalog/application/localSettings';
import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [terminalScreenReader, setTerminalScreenReader] = useLocalSettingMutable('terminalScreenReader');
    const [terminalFontSize, setTerminalFontSize] = useLocalSettingMutable('terminalFontSize');
    // Three-way choices open a sheet with every option and the current one
    // marked, instead of advancing on tap with no visible alternatives.
    const [sheet, setSheet] = React.useState<'theme' | 'avatar' | 'terminalFont' | null>(null);
    const themeOptions: ModelMode[] = [
        { key: 'adaptive', name: t('settingsAppearance.themeOptions.adaptive'), description: t('settingsAppearance.themeDescriptions.adaptive') },
        { key: 'light', name: t('settingsAppearance.themeOptions.light'), description: t('settingsAppearance.themeDescriptions.light') },
        { key: 'dark', name: t('settingsAppearance.themeOptions.dark'), description: t('settingsAppearance.themeDescriptions.dark') },
    ];
    const avatarOptions: ModelMode[] = [
        { key: 'gradient', name: t('settingsAppearance.avatarOptions.gradient') },
        { key: 'pixelated', name: t('settingsAppearance.avatarOptions.pixelated') },
        { key: 'brutalist', name: t('settingsAppearance.avatarOptions.brutalist') },
    ];
    const fontOptions: ModelMode[] = TERMINAL_FONT_SIZES.map((size) => ({ key: String(size), name: `${size} px` }));
    const applyTheme = (nextTheme: 'adaptive' | 'light' | 'dark') => {
        setThemePreference(nextTheme);
        if (nextTheme === 'adaptive') {
            UnistylesRuntime.setAdaptiveThemes(true);
            const systemTheme = Appearance.getColorScheme();
            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
            UnistylesRuntime.setRootViewBackgroundColor(color);
            SystemUI.setBackgroundColorAsync(color);
        } else {
            UnistylesRuntime.setAdaptiveThemes(false);
            UnistylesRuntime.setTheme(nextTheme);
            const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
            UnistylesRuntime.setRootViewBackgroundColor(color);
            SystemUI.setBackgroundColorAsync(color);
        }
    };
    const [preferredLanguage] = useSettingMutable('preferredLanguage');

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';

    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ?
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) :
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <Item
                    title={t('settings.appearance')}
                    subtitle={themePreference === 'adaptive' ? t('settingsAppearance.themeDescriptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeDescriptions.light') : t('settingsAppearance.themeDescriptions.dark')}
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    detail={themePreference === 'adaptive' ? t('settingsAppearance.themeOptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark')}
                    onPress={() => setSheet('theme')}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color={theme.colors.textSecondary} />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    subtitle={t('settingsAppearance.avatarStyleDescription')}
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    detail={displayStyle === 'pixelated' ? t('settingsAppearance.avatarOptions.pixelated') : displayStyle === 'brutalist' ? t('settingsAppearance.avatarOptions.brutalist') : t('settingsAppearance.avatarOptions.gradient')}
                    onPress={() => setSheet('avatar')}
                />
                <Item
                    title="Terminal text size"
                    subtitle="Browser terminal only. Changing it keeps the session connected."
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.textSecondary} />}
                    detail={`${terminalFontSize} px`}
                    onPress={() => setSheet('terminalFont')}
                />
                <Item
                    title="Accessible terminal"
                    subtitle="Expose terminal text to screen readers in the browser. Slower on very busy output."
                    icon={<Ionicons name="accessibility-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={
                        <Switch
                            value={terminalScreenReader}
                            onValueChange={setTerminalScreenReader}
                            accessibilityLabel="Accessible terminal"
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
            </ItemGroup>
            <OptionSheet
                visible={sheet === 'theme'}
                title={t('settings.appearance')}
                options={themeOptions}
                selectedKey={themePreference}
                onSelect={(option) => { applyTheme(option.key as 'adaptive' | 'light' | 'dark'); setSheet(null); }}
                onClose={() => setSheet(null)}
            />
            <OptionSheet
                visible={sheet === 'avatar'}
                title={t('settingsAppearance.avatarStyle')}
                options={avatarOptions}
                selectedKey={displayStyle}
                onSelect={(option) => { setAvatarStyle(option.key as KnownAvatarStyle); setSheet(null); }}
                onClose={() => setSheet(null)}
            />
            <OptionSheet
                visible={sheet === 'terminalFont'}
                title="Terminal text size"
                options={fontOptions}
                selectedKey={String(terminalFontSize)}
                onSelect={(option) => { setTerminalFontSize(Number(option.key) as typeof terminalFontSize); setSheet(null); }}
                onClose={() => setSheet(null)}
            />
        </ItemList>
    );
}
