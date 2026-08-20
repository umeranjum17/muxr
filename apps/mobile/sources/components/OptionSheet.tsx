import * as React from 'react';
import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    FlatList,
    Modal as RNModal,
    Platform,
    TouchableWithoutFeedback,
    useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ProviderIcon } from './ProviderIcon';
import { hapticsLight } from './haptics';
import { t } from '@/text';
export interface ModelMode {
    key: string;
    name: string;
    description?: string;
    disabled?: boolean;
    contextWindow?: number;
    providerName?: string;
    providerKind?: string;
}
import { ALL_PROVIDERS, filterModels, groupByProvider } from '@/utils/optionSheet';

const SEARCH_THRESHOLD = 8;
const ROW_HEIGHT = 54;

function formatContextWindow(contextWindow?: number): string | null {
    if (!contextWindow || contextWindow <= 0) return null;
    if (contextWindow >= 1_000_000) return `${Math.round(contextWindow / 100_000) / 10}M`;
    return `${Math.round(contextWindow / 1000)}K`;
}

export function OptionSheet({
    visible,
    title,
    options: models,
    selectedKey,
    onSelect,
    onClose,
    emptyText,
    footer,
    body,
    virtualizedBody = false,
    virtualizedBodyHeight,
    onSubmitCustom,
    searchPlaceholder,
}: {
    visible: boolean;
    title: string;
    options: ModelMode[];
    /** Renders in place of the option list, for a sheet that reports rather than picks. */
    body?: React.ReactNode;
    /** The body owns scrolling (usually a FlatList), so do not nest it in a ScrollView. */
    virtualizedBody?: boolean;
    /** Content height before the sheet cap is applied. */
    virtualizedBodyHeight?: number;
    selectedKey?: string | null;
    onSelect: (option: ModelMode) => void;
    onClose: () => void;
    emptyText?: string;
    footer?: React.ReactNode;
    // Lets the search field double as free-text entry (custom project paths).
    onSubmitCustom?: (value: string) => void;
    searchPlaceholder?: string;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [search, setSearch] = React.useState('');
    const [provider, setProvider] = React.useState<string>(ALL_PROVIDERS);

    // A sheet reopened after a switch should start from a clean slate.
    React.useEffect(() => {
        if (!visible) {
            setSearch('');
            setProvider(ALL_PROVIDERS);
        }
    }, [visible]);

    const providers = React.useMemo(() => groupByProvider(models), [models]);
    const visibleModels = React.useMemo(
        () => filterModels(models, provider, search),
        [models, provider, search],
    );
    const sheetCap = Math.min(windowHeight * 0.82, windowHeight - safeArea.top - 24);
    const showSearch = !!onSubmitCustom || models.length > SEARCH_THRESHOLD;
    const typed = search.trim();
    const custom = onSubmitCustom && typed.length > 0 && !models.some((model) => model.name === typed)
        ? typed
        : null;

    const select = (model: ModelMode) => {
        if (model.disabled) return;
        hapticsLight();
        if (custom && model.key === custom) {
            onSubmitCustom?.(custom);
            onClose();
            return;
        }
        onSelect(model);
        onClose();
    };

    const renderRow = (model: ModelMode) => {
        const isSelected = model.key === selectedKey;
        const context = formatContextWindow(model.contextWindow);
        return (
            <Pressable
                key={model.key}
                onPress={() => select(model)}
                style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: theme.colors.surfacePressedOverlay },
                    model.disabled && { opacity: 0.45 },
                ]}
            >
                <Ionicons
                    name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={20}
                    color={isSelected ? theme.colors.textLink : theme.colors.textSecondary}
                />
                <View style={styles.rowCopy}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{model.name}</Text>
                    {!!model.description && (
                        <Text style={styles.rowSubtitle} numberOfLines={2}>{model.description}</Text>
                    )}
                </View>
                {context && <Text style={styles.contextChip}>{context}</Text>}
            </Pressable>
        );
    };

    return (
        <RNModal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={onClose}
            statusBarTranslucent
        >
            <View style={styles.overlay}>
                <TouchableWithoutFeedback onPress={onClose}>
                    <View style={styles.backdrop} />
                </TouchableWithoutFeedback>
                <View style={[
                    styles.sheet,
                    // A body sheet has no rows to measure, so it grows with its content
                    // and the inner ScrollView takes the cap instead.
                    body
                        ? { maxHeight: sheetCap }
                        : {
                            height: Math.min(
                                96 + (showSearch ? 48 : 0) + Math.max(models.length, 1) * ROW_HEIGHT,
                                sheetCap,
                            ),
                        },
                    { paddingBottom: Math.max(12, safeArea.bottom) },
                ]}>
                    <View style={styles.handleRow}>
                        <View style={styles.handle} />
                    </View>
                    <Text style={styles.title}>{title}</Text>

                    {body ? (
                        virtualizedBody
                            ? <View style={{ height: Math.min(sheetCap - 108, virtualizedBodyHeight ?? sheetCap - 108) }}>{body}</View>
                            : <ScrollView style={{ maxHeight: sheetCap - 108 }}>{body}</ScrollView>
                    ) : (
                    <View style={styles.body}>
                        {providers.length > 1 && (
                            <ScrollView
                                style={styles.rail}
                                contentContainerStyle={styles.railContent}
                                showsVerticalScrollIndicator={false}
                            >
                                {[{ name: ALL_PROVIDERS, count: models.length, kind: undefined }, ...providers].map((entry) => {
                                    const isActive = provider === entry.name;
                                    return (
                                        <Pressable
                                            key={entry.name}
                                            onPress={() => setProvider(entry.name)}
                                            style={[styles.railItem, isActive && styles.railItemActive]}
                                        >
                                            {entry.name === ALL_PROVIDERS
                                                ? <Ionicons name="apps-outline" size={18} color={theme.colors.textSecondary} />
                                                : <ProviderIcon kind={entry.kind} size={18} />}
                                            <Text
                                                style={[styles.railLabel, isActive && styles.railLabelActive]}
                                                numberOfLines={1}
                                            >
                                                {entry.name === ALL_PROVIDERS ? t('optionSheet.all') : entry.name}
                                            </Text>
                                            <Text style={styles.railCount}>{entry.count}</Text>
                                        </Pressable>
                                    );
                                })}
                            </ScrollView>
                        )}

                        <View style={styles.listColumn}>
                            {showSearch && (
                                <View style={styles.searchRow}>
                                    <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                                    <TextInput
                                        value={search}
                                        onChangeText={setSearch}
                                        onSubmitEditing={() => {
                                            if (!custom) return;
                                            onSubmitCustom?.(custom);
                                            onClose();
                                        }}
                                        placeholder={searchPlaceholder ?? t('optionSheet.searchPlaceholder', { count: models.length })}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        returnKeyType={onSubmitCustom ? 'go' : 'search'}
                                        style={styles.searchInput}
                                    />
                                </View>
                            )}
                            {models.length === 0 ? (
                                <Text style={styles.emptyText}>{emptyText ?? t('agentInput.model.configureInCli')}</Text>
                            ) : (
                                <FlatList
                                    data={visibleModels}
                                    keyExtractor={(model) => model.key}
                                    renderItem={({ item }) => renderRow(item)}
                                    keyboardShouldPersistTaps="handled"
                                    ListHeaderComponent={custom ? renderRow({ key: custom, name: t('optionSheet.useCustom', { value: custom }) }) : null}
                                    ListEmptyComponent={custom ? null : <Text style={styles.emptyText}>{t('optionSheet.noResults')}</Text>}
                                    ListFooterComponent={footer ? <>{footer}</> : null}
                                    initialNumToRender={12}
                                />
                            )}
                        </View>
                    </View>
                    )}
                </View>
            </View>
        </RNModal>
    );
}

const styles = StyleSheet.create((theme) => ({
    overlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
    },
    sheet: {
        backgroundColor: theme.colors.groupped.background,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
    },
    handleRow: {
        alignItems: 'center',
        paddingTop: 8,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.textSecondary,
        opacity: 0.5,
    },
    title: {
        fontSize: 24,
        color: theme.colors.text,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 12,
        ...Typography.default('semiBold'),
    },
    body: {
        flex: 1,
        flexDirection: 'row',
    },
    rail: {
        width: 92,
        flexGrow: 0,
    },
    railContent: {
        paddingBottom: 12,
    },
    railItem: {
        alignItems: 'center',
        gap: 2,
        paddingVertical: 12,
        paddingHorizontal: 4,
    },
    railItemActive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    railLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    railLabelActive: {
        color: theme.colors.text,
    },
    railCount: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    listColumn: {
        flex: 1,
        minWidth: 0,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 12,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: Platform.OS === 'web' ? 8 : 6,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    searchInput: {
        flex: 1,
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default(),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginHorizontal: 6,
        borderRadius: 12,
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    rowSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    contextChip: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    emptyText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        padding: 16,
        ...Typography.default(),
    },
}));
