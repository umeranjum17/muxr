import * as React from 'react';
import { Keyboard, Modal as SheetModal, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useLocalSettingMutable } from '@/catalog/store';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { hapticsSelection } from '@/components/haptics';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import {
    READABLE_CONTRAST,
    TERMINAL_ANSI_SLOTS,
    TERMINAL_BASE_SLOTS,
    contrastRatio,
    hexToHsv,
    hsvToHex,
    normalizeHex,
    terminalColorName,
    type Hsv,
    type TerminalColorSlot,
    type TerminalColors,
} from '../domain/terminalColors';
import { TERMINAL_COLOR_DEFAULTS, useTerminalColors } from './useTerminalColors';

// The phone's terminal swaps text and background for a selection it was given
// no colour for; the browser's lays its own tint.
const NATIVE_INVERTED_SELECTION = Platform.OS !== 'web';

/** What a slot is measured against for legibility. */
function contrastPartner(slot: TerminalColorSlot, colors: TerminalColors): string {
    return slot === 'background' || slot === 'selection' ? colors.foreground : colors.background;
}

function formatRatio(ratio: number): string {
    return `${ratio.toFixed(1)}:1`;
}

function selectionLook(colors: TerminalColors, overridden: boolean): { background: string; color: string } {
    if (!overridden && NATIVE_INVERTED_SELECTION) return { background: colors.foreground, color: colors.background };
    return { background: colors.selection, color: colors.foreground };
}

function Run({ color, children }: { color: string; children: string }) {
    return <Text style={{ color }}>{children}</Text>;
}

/**
 * A few lines of ordinary terminal output drawn in the chosen colours, so a
 * change reads the way it will in a real session before leaving Settings.
 */
function TerminalColorsPreview({ colors, selectionOverridden }: { colors: TerminalColors; selectionOverridden: boolean }) {
    const ansi = (index: number) => colors[TERMINAL_ANSI_SLOTS[index]!];
    const selection = selectionLook(colors, selectionOverridden);
    return (
        <View
            accessible
            accessibilityRole="image"
            accessibilityLabel="Terminal preview in the chosen colors"
            style={[styles.preview, { backgroundColor: colors.background }]}
        >
            <Text style={[styles.previewLine, { color: colors.foreground }]} numberOfLines={1}>
                <Run color={ansi(2)}>~/app</Run>{' '}<Run color={ansi(4)}>main</Run> $ git status
            </Text>
            <Text style={[styles.previewLine, { color: colors.foreground }]} numberOfLines={1}>
                <Run color={ansi(1)}>  modified:</Run> src/index.ts
            </Text>
            <Text style={[styles.previewLine, { color: colors.foreground }]} numberOfLines={1}>
                <Run color={ansi(10)}>✓ 12 pass</Run>{' '}<Run color={ansi(9)}>✗ 1 fail</Run>{' '}<Run color={ansi(3)}>2 skip</Run>
            </Text>
            <Text style={[styles.previewLine, { color: colors.foreground }]} numberOfLines={1}>
                <Run color={ansi(12)}>docs/</Run>{' '}<Run color={ansi(5)}>build.sh</Run>{' '}<Run color={ansi(6)}>README</Run>{' '}<Run color={ansi(8)}># notes</Run>
            </Text>
            <Text style={[styles.previewLine, { color: colors.foreground }]} numberOfLines={1}>
                $ <Text style={{ backgroundColor: selection.background, color: selection.color }}>npm test</Text>
                {' '}<Text style={{ color: colors.cursor }}>█</Text>
            </Text>
            <View style={styles.previewStrip}>
                {TERMINAL_ANSI_SLOTS.map((slot) => (
                    <View key={slot} style={[styles.previewChip, { backgroundColor: colors[slot] }]} />
                ))}
            </View>
        </View>
    );
}

function ContrastWarning({ ratio, subject }: { ratio: number; subject: string }) {
    const { theme } = useUnistyles();
    const box = theme.colors.box.warning;
    return (
        <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[styles.warning, { backgroundColor: box.background, borderColor: box.border }]}
        >
            <Ionicons name="warning-outline" size={18} color={box.text} />
            <Text style={[styles.warningText, { color: theme.colors.text }]}>
                {subject} may be hard to read ({formatRatio(ratio)}). Aim for at least {formatRatio(READABLE_CONTRAST)}.
            </Text>
        </View>
    );
}

function Swatch({ color, size = 28, inverted }: { color: string; size?: number; inverted?: string }) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.swatch, { width: size, height: size, borderRadius: size / 4, backgroundColor: color, borderColor: theme.dark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(0, 0, 0, 0.18)' }]}>
            {inverted !== undefined && <View style={[styles.swatchHalf, { backgroundColor: inverted, borderBottomRightRadius: size / 4 }]} />}
        </View>
    );
}

type Channel = keyof Hsv;
const CHANNELS: { key: Channel; label: string; max: number; unit: string; step: number }[] = [
    { key: 'h', label: 'Hue', max: 360, unit: '°', step: 5 },
    { key: 's', label: 'Saturation', max: 1, unit: '%', step: 0.05 },
    { key: 'v', label: 'Brightness', max: 1, unit: '%', step: 0.05 },
];
const HUE_STOPS = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'] as const;

/**
 * One HSV channel as a drag track. Built on the responder system rather than
 * a gesture library so it behaves the same inside a modal on every platform,
 * and exposed as an adjustable control for screen readers.
 */
function ChannelSlider({ hsv, channel, onChange }: { hsv: Hsv; channel: typeof CHANNELS[number]; onChange: (next: Hsv) => void }) {
    const [width, setWidth] = React.useState(0);
    const value = hsv[channel.key];
    const fraction = Math.min(1, Math.max(0, value / channel.max));
    const set = (next: number) => onChange({ ...hsv, [channel.key]: Math.min(channel.max, Math.max(0, next)) });
    // The thumb's centre travels THUMB/2 in from each end, so a touch on the
    // thumb itself lands on the value it already shows.
    const fromTouch = (x: number) => { if (width > THUMB) set(((x - THUMB / 2) / (width - THUMB)) * channel.max); };
    const stops: readonly [string, string, ...string[]] = channel.key === 'h'
        ? HUE_STOPS
        : channel.key === 's'
            ? [hsvToHex({ ...hsv, s: 0 }), hsvToHex({ ...hsv, s: 1 })]
            : ['#000000', hsvToHex({ ...hsv, v: 1 })];
    const shown = channel.key === 'h' ? Math.round(value) : Math.round(value * 100);
    return (
        <View style={styles.channel}>
            <Text style={styles.channelLabel}>{channel.label}</Text>
            <View
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={channel.label}
                accessibilityValue={{ text: `${shown}${channel.unit}` }}
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={({ nativeEvent }) => set(value + (nativeEvent.actionName === 'increment' ? channel.step : -channel.step))}
                onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                // A sideways drag must stay with the track, not scroll or close the sheet.
                onResponderTerminationRequest={() => false}
                onResponderGrant={({ nativeEvent }) => fromTouch(nativeEvent.locationX)}
                onResponderMove={({ nativeEvent }) => fromTouch(nativeEvent.locationX)}
                style={styles.track}
            >
                <LinearGradient pointerEvents="none" colors={stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={TRACK_FILL} />
                <View pointerEvents="none" style={[styles.thumb, { left: fraction * Math.max(0, width - THUMB) }]} />
            </View>
        </View>
    );
}

const THUMB = 26;
// Plain object: unistyles only styles the components it compiles, not the gradient.
const TRACK_FILL = { height: 18, borderRadius: 9 };

/**
 * Picks one slot's colour: drag hue, saturation and brightness, type a hex
 * code, or take a colour already in the palette. Nothing is saved until Done;
 * Done after Default hands the slot back to the renderer (null).
 */
function ColorEditor({ slot, colors, overridden, onDone, onClose }: {
    slot: TerminalColorSlot;
    colors: TerminalColors;
    overridden: boolean;
    onDone: (hex: string | null) => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const initial = colors[slot];
    const [hsv, setHsv] = React.useState(() => hexToHsv(initial));
    const [isDefault, setIsDefault] = React.useState(!overridden);
    const hex = hsvToHex(hsv);
    const [draft, setDraft] = React.useState(hex);
    const pick = (next: Hsv) => { setHsv(next); setDraft(hsvToHex(next)); setIsDefault(false); };
    const typed = (text: string) => {
        setDraft(text);
        const parsed = normalizeHex(text);
        if (parsed !== null) { setHsv(hexToHsv(parsed)); setIsDefault(false); }
        // A full code is the end of typing on a phone: drop the keyboard so the
        // colour shows and the first tap on Done lands (while the keyboard is
        // up, Android spends that tap taking focus off the field). The web
        // keeps focus, so Enter still submits.
        if (Platform.OS !== 'web' && /^#?[0-9a-f]{6}$/i.test(text.trim())) Keyboard.dismiss();
    };
    const draftValid = normalizeHex(draft) !== null;
    const name = terminalColorName(slot);
    const partner = contrastPartner(slot, colors);
    const ratio = contrastRatio(hex, partner);
    const invertedDefault = slot === 'selection' && isDefault && NATIVE_INVERTED_SELECTION;
    const sample = slot === 'background'
        ? { background: hex, color: colors.foreground }
        : slot === 'selection' ? { background: hex, color: colors.foreground } : { background: colors.background, color: hex };
    const defaultHex = TERMINAL_COLOR_DEFAULTS[slot];
    const suggestions = [...new Set([...TERMINAL_ANSI_SLOTS.map((s) => colors[s]), colors.foreground, colors.background])];
    const useDefault = () => {
        hapticsSelection();
        setHsv(hexToHsv(defaultHex));
        setDraft(defaultHex);
        setIsDefault(true);
    };

    return (
        // Its own modal rather than BaseModal: BaseModal's height-based
        // avoidance stayed shrunk on Android after Back hid the keyboard,
        // pushing Done under the status bar.
        <SheetModal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
            <KeyboardAvoidingView
                behavior="padding"
                style={[styles.sheetRoot, { paddingTop: insets.top + 24 }]}
            >
                <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
                <View style={[styles.sheet, { width: Math.min(width, 480), paddingBottom: insets.bottom }]} accessibilityViewIsModal>
                    <View style={styles.sheetHeader}>
                        <Text style={styles.sheetTitle} accessibilityRole="header">{name}</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={10} onPress={onClose}>
                            <Text style={[styles.sheetAction, { color: theme.colors.textSecondary }]}>Cancel</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={isDefault ? `Use the default for ${name}` : `Use ${hex} for ${name}`}
                            accessibilityState={{ disabled: !draftValid }}
                            disabled={!draftValid}
                            hitSlop={10}
                        onPress={() => { hapticsSelection(); onDone(isDefault ? null : hex); }}
                        >
                            <Text style={[styles.sheetAction, { color: draftValid ? theme.colors.textLink : theme.colors.textSecondary, ...Typography.default('semiBold') }]}>Done</Text>
                        </Pressable>
                    </View>
                    <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
                        <View style={styles.compare}>
                            <View style={[styles.compareSample, { backgroundColor: invertedDefault ? colors.foreground : sample.background }]}>
                                <Text style={[styles.compareText, { color: invertedDefault ? colors.background : sample.color }]} numberOfLines={1}>{slot === 'cursor' ? '$ ' : 'Sample text'}</Text>
                                {slot === 'cursor' && <View style={[styles.compareCursor, { backgroundColor: hex }]} />}
                            </View>
                            <View style={styles.compareSwatches} accessibilityLabel={`Was ${initial}, now ${hex}`} accessible>
                                <Swatch color={initial} size={22} />
                                <Ionicons name="arrow-forward" size={14} color={theme.colors.textSecondary} />
                                <Swatch color={hex} size={22} />
                            </View>
                        </View>
                        {invertedDefault ? (
                            <Text style={[styles.ratio, { color: theme.colors.textSecondary }]}>The default swaps text and background</Text>
                        ) : (
                            <Text style={[styles.ratio, { color: ratio < READABLE_CONTRAST ? theme.colors.box.warning.text : theme.colors.textSecondary }]}>
                                {ratio < READABLE_CONTRAST ? 'Low contrast' : 'Contrast'} {formatRatio(ratio)} against {slot === 'background' || slot === 'selection' ? 'text' : 'background'}
                            </Text>
                        )}
                        {CHANNELS.map((channel) => <ChannelSlider key={channel.key} hsv={hsv} channel={channel} onChange={pick} />)}
                        <View style={styles.hexRow}>
                            <Text style={styles.channelLabel}>Hex</Text>
                            <TextInput
                                value={draft}
                                onChangeText={typed}
                                onBlur={() => { if (normalizeHex(draft) === null) setDraft(hex); }}
                                autoCapitalize="none"
                                autoCorrect={false}
                                maxLength={7}
                                returnKeyType="done"
                                onSubmitEditing={() => { if (draftValid) onDone(isDefault ? null : hex); }}
                                accessibilityLabel={`${name} hex code`}
                                accessibilityHint="Six hex digits, like #1e90ff"
                                placeholder="#rrggbb"
                                placeholderTextColor={theme.colors.textSecondary}
                                style={[styles.hexInput, { color: theme.colors.text, borderColor: draftValid ? theme.colors.divider : theme.colors.box.error.border }]}
                            />
                        </View>
                        <Text style={styles.channelLabel}>From the palette</Text>
                        <View style={styles.suggestions}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Default, ${slot === 'selection' && NATIVE_INVERTED_SELECTION ? 'swaps text and background' : defaultHex}`}
                                accessibilityState={{ selected: isDefault }}
                                hitSlop={4}
                                onPress={useDefault}
                                style={[styles.suggestion, isDefault && { borderColor: theme.colors.textLink }]}
                            >
                                <Swatch
                                    color={slot === 'selection' && NATIVE_INVERTED_SELECTION ? TERMINAL_COLOR_DEFAULTS.foreground : defaultHex}
                                    inverted={slot === 'selection' && NATIVE_INVERTED_SELECTION ? TERMINAL_COLOR_DEFAULTS.background : undefined}
                                    size={26}
                                />
                                <Text style={styles.suggestionLabel}>Default</Text>
                            </Pressable>
                            {suggestions.map((color) => (
                                <Pressable
                                    key={color}
                                    accessibilityRole="button"
                                    accessibilityLabel={color}
                                    accessibilityState={{ selected: !isDefault && color === hex }}
                                    hitSlop={4}
                                    onPress={() => { hapticsSelection(); pick(hexToHsv(color)); }}
                                    style={[styles.suggestion, !isDefault && color === hex && { borderColor: theme.colors.textLink }]}
                                >
                                    <Swatch color={color} size={26} />
                                </Pressable>
                            ))}
                        </View>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </SheetModal>
    );
}

export function TerminalColorsSettings() {
    const { theme } = useUnistyles();
    const [, setStored] = useLocalSettingMutable('terminalColors');
    const { colors, overrides } = useTerminalColors();
    const [editing, setEditing] = React.useState<TerminalColorSlot | null>(null);
    const changed = Object.keys(overrides).length;
    const textRatio = contrastRatio(colors.foreground, colors.background);

    // An explicit pick is kept even when it matches the default: the phone's
    // default selection is a swap, not a colour, so white is a real choice.
    const save = (slot: TerminalColorSlot, hex: string | null) => {
        const next = { ...overrides } as Record<string, string>;
        if (hex === null) delete next[slot];
        else next[slot] = hex;
        setStored(next);
    };
    const reset = async () => {
        const confirmed = await Modal.confirm('Reset terminal colors?', 'Every color goes back to the default.', {
            confirmText: 'Reset',
            destructive: true,
        });
        if (confirmed) setStored({});
    };

    const baseSubtitle = (slot: typeof TERMINAL_BASE_SLOTS[number]) => {
        if (overrides[slot] !== undefined) return overrides[slot];
        if (slot === 'selection' && NATIVE_INVERTED_SELECTION) return 'Default · swaps text and background';
        return `${colors[slot]} · Default`;
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <View style={styles.previewWrap}>
                <TerminalColorsPreview colors={colors} selectionOverridden={overrides.selection !== undefined} />
                {textRatio < READABLE_CONTRAST && <ContrastWarning ratio={textRatio} subject="Text on this background" />}
            </View>

            <ItemGroup title="Base">
                {TERMINAL_BASE_SLOTS.map((slot) => (
                    <Item
                        key={slot}
                        title={terminalColorName(slot)}
                        subtitle={baseSubtitle(slot)}
                        accessibilityLabel={`${terminalColorName(slot)}, ${baseSubtitle(slot)}`}
                        leftElement={(
                            <Swatch
                                color={slot === 'selection' ? selectionLook(colors, overrides.selection !== undefined).background : colors[slot]}
                                inverted={slot === 'selection' && overrides.selection === undefined && NATIVE_INVERTED_SELECTION ? colors.background : undefined}
                            />
                        )}
                        onPress={() => setEditing(slot)}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title="Palette" footer="Programs color their output from these 16. A dot marks a color you changed.">
                {(['Normal', 'Bright'] as const).map((row, rowIndex) => (
                    <View key={row} style={styles.paletteRow}>
                        <Text style={styles.paletteLabel}>{row}</Text>
                        <View style={styles.paletteSwatches}>
                            {TERMINAL_ANSI_SLOTS.slice(rowIndex * 8, rowIndex * 8 + 8).map((slot) => {
                                const custom = overrides[slot] !== undefined;
                                const low = contrastRatio(colors[slot], colors.background) < 1.5;
                                return (
                                    <Pressable
                                        key={slot}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${terminalColorName(slot)}, ${colors[slot]}${custom ? ', changed' : ''}${low ? ', barely visible on the background' : ''}`}
                                        hitSlop={4}
                                        onPress={() => setEditing(slot)}
                                        style={({ pressed }) => [styles.paletteCell, pressed && { opacity: 0.6 }]}
                                    >
                                        <View style={[styles.paletteSwatch, { backgroundColor: colors[slot], borderColor: theme.dark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(0, 0, 0, 0.18)' }]} />
                                        {custom && <View style={[styles.paletteDot, { backgroundColor: theme.colors.textLink }]} />}
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                ))}
            </ItemGroup>

            <ItemGroup footer={changed > 0 ? `${changed} ${changed === 1 ? 'color differs' : 'colors differ'} from the default.` : 'Showing the default colors.'}>
                <Item
                    title="Reset to defaults"
                    destructive
                    disabled={changed === 0}
                    showChevron={false}
                    onPress={() => { void reset(); }}
                />
            </ItemGroup>

            {editing !== null && (
                <ColorEditor
                    key={editing}
                    slot={editing}
                    colors={colors}
                    overridden={overrides[editing] !== undefined}
                    onDone={(hex) => { save(editing, hex); setEditing(null); }}
                    onClose={() => setEditing(null)}
                />
            )}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    previewWrap: { paddingHorizontal: 16, paddingTop: 16, gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
    preview: {
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    previewLine: { ...Typography.mono(), fontSize: 12, lineHeight: 17 },
    previewStrip: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6, gap: 3 },
    previewChip: { width: '10.5%', height: 8, borderRadius: 2 },
    warning: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
    warningText: { ...Typography.default(), fontSize: 13, flex: 1 },
    swatch: { borderWidth: 1, overflow: 'hidden', justifyContent: 'flex-end', alignItems: 'flex-end' },
    swatchHalf: { width: '50%', height: '50%' },
    paletteRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 6 },
    paletteLabel: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    paletteSwatches: { flexDirection: 'row', gap: 6 },
    paletteCell: { flex: 1, aspectRatio: 1, maxWidth: 44 },
    paletteSwatch: { flex: 1, borderRadius: 8, borderWidth: 1 },
    paletteDot: { position: 'absolute', top: -3, right: -3, width: 9, height: 9, borderRadius: 4.5, borderWidth: 1.5, borderColor: theme.colors.surface },
    sheetRoot: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0, 0, 0, 0.42)' },
    sheet: {
        flexShrink: 1,
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        overflow: 'hidden',
        borderWidth: theme.dark ? StyleSheet.hairlineWidth : 0,
        borderColor: theme.colors.divider,
    },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
    sheetTitle: { ...Typography.default('semiBold'), fontSize: 18, color: theme.colors.text, flex: 1 },
    sheetAction: { ...Typography.default(), fontSize: 16 },
    sheetBody: { paddingHorizontal: 20, paddingBottom: 28, gap: 12 },
    compare: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    compareSample: { flex: 1, height: 44, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
    compareText: { ...Typography.mono(), fontSize: 14 },
    compareCursor: { width: 9, height: 18 },
    compareSwatches: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    ratio: { ...Typography.default(), fontSize: 13, marginTop: -4 },
    channel: { gap: 6 },
    channelLabel: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    track: { height: 30, justifyContent: 'center' },
    thumb: {
        position: 'absolute',
        width: THUMB,
        height: THUMB,
        borderRadius: THUMB / 2,
        borderWidth: 3,
        borderColor: '#ffffff',
        backgroundColor: 'transparent',
        shadowColor: '#000000',
        shadowOpacity: 0.35,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
        elevation: 3,
    },
    hexRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    // A background of its own drops Android's EditText underline inside the box.
    hexInput: { ...Typography.mono(), flex: 1, backgroundColor: 'transparent', fontSize: 16, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.select({ ios: 10, default: 8 }) },
    suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    suggestion: { alignItems: 'center', gap: 2, padding: 3, borderRadius: 10, borderWidth: 2, borderColor: 'transparent' },
    suggestionLabel: { ...Typography.default(), fontSize: 10, color: theme.colors.textSecondary },
}));
