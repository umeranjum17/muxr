import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { DEFAULT_FONT_INDEX, FONT_STEPS, clampFontIndex } from '@/terminal/domain/fontSteps';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { Appearance, StyleSheet, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { Typography } from '@/constants/Typography';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

const TILE_WIDTH = 44;

/**
 * A theme in miniature, painted with its own tokens: the page, a card on it,
 * a status dot, a line of text and a quieter line under it. Given two
 * palettes it splits down the middle, the way Automatic follows the system
 * between them.
 */
function ThemeTile({ palettes }: { palettes: readonly Theme['colors'][] }) {
    const { theme } = useUnistyles();
    const slice = TILE_WIDTH / palettes.length;
    return (
        <View style={[styles.tile, { borderColor: theme.colors.divider }]}>
            {palettes.map((colors, index) => (
                <View key={index} style={{ width: slice, overflow: 'hidden' }}>
                    <View style={[styles.tilePage, { marginLeft: -slice * index, backgroundColor: colors.groupped.background }]}>
                        <View style={[styles.tileCard, { backgroundColor: colors.surface }]}>
                            <View style={styles.tileLine}>
                                <View style={[styles.tileDot, { backgroundColor: colors.status.connected }]} />
                                <View style={[styles.tileBar, { width: 16, backgroundColor: colors.text }]} />
                            </View>
                            <View style={[styles.tileBar, { width: 22, backgroundColor: colors.textSecondary }]} />
                        </View>
                    </View>
                </View>
            ))}
        </View>
    );
}

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [terminalFontIndex, setTerminalFontIndex] = useLocalSettingMutable('terminalFontIndex');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [sheet, setSheet] = React.useState<'theme' | 'avatar' | 'font' | null>(null);
    const themeOptions: ModelMode[] = [
        { key: 'adaptive', name: t('settingsAppearance.themeOptions.adaptive'), description: t('settingsAppearance.themeDescriptions.adaptive'), preview: <ThemeTile palettes={[lightTheme.colors, darkTheme.colors]} /> },
        { key: 'light', name: t('settingsAppearance.themeOptions.light'), description: t('settingsAppearance.themeDescriptions.light'), preview: <ThemeTile palettes={[lightTheme.colors]} /> },
        { key: 'dark', name: t('settingsAppearance.themeOptions.dark'), description: t('settingsAppearance.themeDescriptions.dark'), preview: <ThemeTile palettes={[darkTheme.colors]} /> },
    ];
    const avatarOptions: ModelMode[] = [
        { key: 'pixelated', name: t('settingsAppearance.avatarOptions.pixelated') },
        { key: 'gradient', name: t('settingsAppearance.avatarOptions.gradient') },
        { key: 'brutalist', name: t('settingsAppearance.avatarOptions.brutalist') },
    ];
    const fontIndex = clampFontIndex(terminalFontIndex);
    // Each size carries a sample at that size: the glyphs a small terminal
    // face confuses first, so the choice is about what stays readable.
    const fontOptions: ModelMode[] = FONT_STEPS.map((size, index) => ({
        key: String(index),
        name: `${size}pt${index === DEFAULT_FONT_INDEX ? ' · default' : ''}`,
        preview: <Text style={{ fontSize: size, color: theme.colors.text, ...Typography.mono() }}>0O 1lI</Text>,
    }));

    // Keep the selected value visible in the row while showing every choice in one place.
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    const applyTheme = (nextTheme: 'adaptive' | 'light' | 'dark') => {
        setThemePreference(nextTheme);
        if (nextTheme === 'adaptive') {
            UnistylesRuntime.setAdaptiveThemes(true);
            const systemTheme = Appearance.getColorScheme();
            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
            UnistylesRuntime.setRootViewBackgroundColor(color);
            void SystemUI.setBackgroundColorAsync(color);
            return;
        }
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(nextTheme);
        const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(color);
        void SystemUI.setBackgroundColorAsync(color);
    };

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

            {/* Terminal Settings */}
            <ItemGroup title="Terminal" footer="Text size in shells and terminal panes. Smaller text shows more history on screen; pinch the terminal to change it there too.">
                <Item
                    title="Terminal font size"
                    subtitle="Applies on this device"
                    icon={<Ionicons name="text-outline" size={29} color="#5856D6" />}
                    detail={`${FONT_STEPS[fontIndex]}pt`}
                    onPress={() => setSheet('font')}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    subtitle={t('settingsAppearance.avatarStyleDescription')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#5856D6" />}
                    detail={displayStyle === 'pixelated' ? t('settingsAppearance.avatarOptions.pixelated') : displayStyle === 'brutalist' ? t('settingsAppearance.avatarOptions.brutalist') : t('settingsAppearance.avatarOptions.gradient')}
                    onPress={() => setSheet('avatar')}
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color="#5856D6" />}
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
                onSelect={(option) => applyTheme(option.key as 'adaptive' | 'light' | 'dark')}
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
                visible={sheet === 'font'}
                title="Terminal font size"
                options={fontOptions}
                selectedKey={String(fontIndex)}
                onSelect={(option) => { setTerminalFontIndex(Number(option.key)); setSheet(null); }}
                onClose={() => setSheet(null)}
            />
        </ItemList>
    );
}

const styles = StyleSheet.create({
    tile: { width: TILE_WIDTH, height: 32, flexDirection: 'row', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    tilePage: { width: TILE_WIDTH, height: 32, padding: 5 },
    tileCard: { flex: 1, borderRadius: 4, paddingHorizontal: 5, justifyContent: 'center', gap: 4 },
    tileLine: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    tileDot: { width: 4, height: 4, borderRadius: 2 },
    tileBar: { height: 3, borderRadius: 1.5 },
});
