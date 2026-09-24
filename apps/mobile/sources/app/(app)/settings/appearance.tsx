import * as React from 'react';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { DEFAULT_FONT_INDEX, FONT_STEPS, TERMINAL_FONTS, clampFontIndex, type TerminalFont } from '@/terminal';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { ChoiceSheet, type Choice } from '@/components/ChoiceSheet';
import { AvatarBrutalist } from '@/components/AvatarBrutalist';
import { AvatarGradient } from '@/components/AvatarGradient';
import { AvatarSkia } from '@/components/AvatarSkia';
import { Appearance, Platform, StyleSheet, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { Typography } from '@/constants/Typography';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';

type ThemePreference = 'adaptive' | 'light' | 'dark';
type AvatarStyle = 'pixelated' | 'gradient' | 'brutalist';
type TerminalBars = 'seamless' | 'raised';

const isAvatarStyle = (style: string): style is AvatarStyle =>
    style === 'pixelated' || style === 'gradient' || style === 'brutalist';

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
        <View style={[styles.tile, { borderColor: theme.dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.14)' }]}>
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

/**
 * A terminal in miniature: a header line, a few rows of output and the
 * composer, with the header and footer in the ink the choice would give them.
 */
function BarsTile({ bars }: { bars: TerminalBars }) {
    const ink = darkTheme.colors.terminalChrome;
    const bar = bars === 'raised' ? ink.chrome : ink.canvas;
    return (
        <View style={[styles.tile, { flexDirection: 'column', borderColor: 'rgba(255, 255, 255, 0.2)', backgroundColor: ink.canvas }]}>
            <View style={[styles.barsEdge, { height: 7, backgroundColor: bar }]}>
                <View style={[styles.tileBar, { width: 14, backgroundColor: darkTheme.colors.textSecondary }]} />
            </View>
            <View style={styles.barsOutput}>
                <View style={[styles.tileBar, { width: 26, backgroundColor: darkTheme.colors.textSecondary }]} />
                <View style={[styles.tileBar, { width: 18, backgroundColor: darkTheme.colors.textSecondary }]} />
            </View>
            <View style={[styles.barsEdge, { height: 9, backgroundColor: bar }]}>
                <View style={[styles.tileBar, { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255, 255, 255, 0.14)' }]} />
            </View>
        </View>
    );
}

function applyTheme(next: ThemePreference): void {
    UnistylesRuntime.setAdaptiveThemes(next === 'adaptive');
    if (next !== 'adaptive') UnistylesRuntime.setTheme(next);
    const dark = next === 'adaptive' ? Appearance.getColorScheme() === 'dark' : next === 'dark';
    const color = dark ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    void SystemUI.setBackgroundColorAsync(color);
}

function languageName(preferred: string | null): string {
    if (preferred !== null && preferred in SUPPORTED_LANGUAGES) {
        return getLanguageNativeName(preferred as keyof typeof SUPPORTED_LANGUAGES);
    }
    const device = (Localization.getLocales()?.[0]?.languageTag ?? 'en-US').split('-')[0].toLowerCase();
    const detected = getLanguageNativeName((device in SUPPORTED_LANGUAGES ? device : 'en') as keyof typeof SUPPORTED_LANGUAGES);
    return `${t('settingsLanguage.automatic')} (${detected})`;
}

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [terminalFontIndex, setTerminalFontIndex] = useLocalSettingMutable('terminalFontIndex');
    const [terminalFont, setTerminalFont] = useLocalSettingMutable('terminalFont');
    const [pinchZoom] = useLocalSettingMutable('terminalPinchZoom');
    const [terminalBars, setTerminalBars] = useLocalSettingMutable('terminalBars');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [sheet, setSheet] = React.useState<'theme' | 'size' | 'font' | 'bars' | 'avatar' | null>(null);
    const close = () => setSheet(null);

    const themeName = (key: ThemePreference) => t(`settingsAppearance.themeOptions.${key}`);
    const themeChoices: Choice[] = [
        { key: 'adaptive', label: themeName('adaptive'), detail: t('settingsAppearance.themeDescriptions.adaptive'), preview: <ThemeTile palettes={[lightTheme.colors, darkTheme.colors]} /> },
        { key: 'light', label: themeName('light'), preview: <ThemeTile palettes={[lightTheme.colors]} /> },
        { key: 'dark', label: themeName('dark'), preview: <ThemeTile palettes={[darkTheme.colors]} /> },
    ];

    // Samples draw in the face the terminal will use: the browser's chosen one,
    // or the app's mono standing in for the phone terminal's built-in face.
    const sampleFamily = Platform.OS === 'web' ? TERMINAL_FONTS[terminalFont].family : Typography.mono().fontFamily;
    const fontIndex = clampFontIndex(terminalFontIndex);
    const sizeChoices: Choice[] = FONT_STEPS.map((size, index) => ({
        key: String(index),
        label: `${size} pt`,
        ...(index === DEFAULT_FONT_INDEX ? { detail: 'Default' } : {}),
        preview: <Text style={[styles.sizeSample, { fontFamily: sampleFamily, fontSize: size, color: theme.colors.text }]}>Aa</Text>,
    }));
    const fontChoices: Choice[] = (Object.keys(TERMINAL_FONTS) as TerminalFont[]).map((key) => ({
        key,
        label: TERMINAL_FONTS[key].name,
        labelStyle: { fontFamily: TERMINAL_FONTS[key].family },
    }));

    const barsName: Record<TerminalBars, string> = { seamless: 'Seamless', raised: 'Raised' };
    const barsChoices: Choice[] = [
        { key: 'seamless', label: barsName.seamless, detail: 'Default', preview: <BarsTile bars="seamless" /> },
        { key: 'raised', label: barsName.raised, preview: <BarsTile bars="raised" /> },
    ];

    const displayStyle: AvatarStyle = isAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    const avatarChoices: Choice[] = [
        { key: 'brutalist', label: t('settingsAppearance.avatarOptions.brutalist'), preview: <AvatarBrutalist id="muxr-appearance" size={32} /> },
        { key: 'gradient', label: t('settingsAppearance.avatarOptions.gradient'), preview: <AvatarGradient id="muxr-appearance" size={32} /> },
        { key: 'pixelated', label: t('settingsAppearance.avatarOptions.pixelated'), preview: <AvatarSkia id="muxr-appearance" size={32} /> },
    ];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="App">
                <Item title={t('settingsAppearance.theme')} subtitle={themeName(themePreference)} onPress={() => setSheet('theme')} />
                <Item title={t('settingsLanguage.title')} subtitle={languageName(preferredLanguage)} onPress={() => router.push('/settings/language')} />
            </ItemGroup>

            <ItemGroup
                title="Terminal"
                footer={pinchZoom ? 'Pinch a terminal to change its size there too.' : undefined}
            >
                <Item title="Text size" subtitle={`${FONT_STEPS[fontIndex]} pt`} onPress={() => setSheet('size')} />
                {Platform.OS === 'web' && (
                    <Item title="Font" subtitle={TERMINAL_FONTS[terminalFont].name} onPress={() => setSheet('font')} />
                )}
                <Item title="Header and footer" subtitle={barsName[terminalBars]} onPress={() => setSheet('bars')} />
            </ItemGroup>

            <ItemGroup title="Avatars" footer="Avatars appear next to recent sessions.">
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    subtitle={t(`settingsAppearance.avatarOptions.${displayStyle}`)}
                    onPress={() => setSheet('avatar')}
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={showFlavorIcons ? 'Shown on avatars' : 'Hidden'}
                    showChevron={false}
                    rightElement={<Switch accessibilityLabel={t('settingsAppearance.showFlavorIcons')} value={showFlavorIcons} onValueChange={setShowFlavorIcons} />}
                />
            </ItemGroup>

            <ChoiceSheet
                visible={sheet === 'theme'}
                title={t('settingsAppearance.theme')}
                choices={themeChoices}
                selectedKey={themePreference}
                onSelect={(key) => {
                    setThemePreference(key as ThemePreference);
                    applyTheme(key as ThemePreference);
                }}
                onClose={close}
            />
            <ChoiceSheet
                visible={sheet === 'size'}
                title="Terminal text size"
                choices={sizeChoices}
                selectedKey={String(fontIndex)}
                onSelect={(key) => setTerminalFontIndex(Number(key))}
                onClose={close}
            />
            <ChoiceSheet
                visible={sheet === 'font'}
                title="Terminal font"
                choices={fontChoices}
                selectedKey={terminalFont}
                onSelect={(key) => setTerminalFont(key as TerminalFont)}
                onClose={close}
            />
            <ChoiceSheet
                visible={sheet === 'bars'}
                title="Terminal header and footer"
                choices={barsChoices}
                selectedKey={terminalBars}
                onSelect={(key) => setTerminalBars(key as TerminalBars)}
                onClose={close}
            />
            <ChoiceSheet
                visible={sheet === 'avatar'}
                title={t('settingsAppearance.avatarStyle')}
                choices={avatarChoices}
                selectedKey={displayStyle}
                onSelect={(key) => setAvatarStyle(key as AvatarStyle)}
                onClose={close}
            />
        </ItemList>
    );
}

const styles = StyleSheet.create({
    tile: { width: TILE_WIDTH, height: 32, flexDirection: 'row', borderRadius: 8, borderWidth: 1, overflow: 'hidden' },
    tilePage: { width: TILE_WIDTH, height: 32, padding: 5 },
    tileCard: { flex: 1, borderRadius: 4, paddingHorizontal: 5, justifyContent: 'center', gap: 4 },
    tileLine: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    tileDot: { width: 4, height: 4, borderRadius: 2 },
    tileBar: { height: 3, borderRadius: 1.5 },
    barsEdge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5 },
    barsOutput: { flex: 1, justifyContent: 'center', gap: 3, paddingHorizontal: 5 },
    sizeSample: { width: 30 },
});
