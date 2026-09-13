import * as React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TERMINAL_FONT_SIZES } from '@/catalog/application/localSettings';
import { applyThemePreference, type ThemePreference } from '@/unistyles';
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
    // Two-to-four-way choices show every option at once; only the six-step
    // text size still opens a sheet.
    const [sheet, setSheet] = React.useState<'terminalFont' | null>(null);
    const themeOptions = [
        { key: 'adaptive', label: t('settingsAppearance.themeOptions.adaptive') },
        { key: 'light', label: t('settingsAppearance.themeOptions.light') },
        { key: 'dark', label: t('settingsAppearance.themeOptions.dark') },
    ] as const;
    const avatarOptions = [
        { key: 'brutalist', label: t('settingsAppearance.avatarOptions.brutalist') },
        { key: 'gradient', label: t('settingsAppearance.avatarOptions.gradient') },
        { key: 'pixelated', label: t('settingsAppearance.avatarOptions.pixelated') },
    ] as const;
    const fontOptions: ModelMode[] = TERMINAL_FONT_SIZES.map((size) => ({ key: String(size), name: `${size} px` }));
    const applyTheme = (nextTheme: ThemePreference) => {
        setThemePreference(nextTheme);
        applyThemePreference(nextTheme);
    };
    const [preferredLanguage] = useSettingMutable('preferredLanguage');

    // An unknown stored style selects no segment rather than pretending.
    const displayStyle: KnownAvatarStyle | undefined = isKnownAvatarStyle(avatarStyle) ? avatarStyle : undefined;

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

            {/* Theme: every choice visible, the current one explained underneath. */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t(`settingsAppearance.themeDescriptions.${themePreference}` as 'settingsAppearance.themeDescriptions.adaptive')}>
                <SegmentedControl accessibilityLabel={t('settingsAppearance.theme')} options={themeOptions} value={themePreference} onChange={applyTheme} />
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
            <ItemGroup title={t('settingsAppearance.avatarStyle')} footer={t('settingsAppearance.avatarStyleDescription')}>
                <SegmentedControl accessibilityLabel={t('settingsAppearance.avatarStyle')} options={avatarOptions} value={displayStyle} onChange={setAvatarStyle} />
            </ItemGroup>
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                {Platform.OS === 'web' && <Item
                    title="Terminal text size"
                    subtitle="Changing it keeps the session connected."
                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.textSecondary} />}
                    detail={`${terminalFontSize} px`}
                    onPress={() => setSheet('terminalFont')}
                />}
                {Platform.OS === 'web' && <Item
                    title="Accessible terminal"
                    subtitle="Expose terminal text to screen readers. Slower on very busy output."
                    icon={<Ionicons name="accessibility-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={
                        <Switch
                            value={terminalScreenReader}
                            onValueChange={setTerminalScreenReader}
                            accessibilityLabel="Accessible terminal"
                        />
                    }
                />}
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                            accessibilityLabel={t('settingsAppearance.showFlavorIcons')}
                        />
                    }
                />
            </ItemGroup>
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
