/**
 * The New-agent screen's one "where" control: the chosen folder as a real
 * value, open workspaces and recent folders one tap away, and a
 * shell-completion-style browser (type-ahead over machine.listDir) behind
 * Browse or a focused field. A pasted path still works blind.
 */

import * as React from 'react';
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    TextInput,
    View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/catalog/sync';
import type { RequestResult } from '@trymuxr/contract';
import { Text } from '@/components/StyledText';
import { basename, resolveListingTarget } from '@/utils/directoryPicker';

type Listing = RequestResult<'machine.listDir'>;

const EXISTENCE_DEBOUNCE_MS = 250;
const ROW_HEIGHT = 44;
const MAX_VISIBLE_ROWS = 7;
const MAX_PLACES = 5;

const styles = StyleSheet.create((theme) => ({
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 12,
        gap: 10,
        minHeight: ROW_HEIGHT,
    },
    input: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 15,
        paddingVertical: 11,
    },
    done: {
        color: theme.colors.textLink,
        fontSize: 14,
        fontWeight: '600',
    },
    hairline: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    rowHairline: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 38,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: ROW_HEIGHT,
        paddingHorizontal: 12,
    },
    rowTexts: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
    },
    rowName: {
        color: theme.colors.text,
        fontSize: 14,
        flexShrink: 0,
        maxWidth: '70%',
    },
    rowMeta: {
        flex: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    browseText: {
        flex: 1,
        color: theme.colors.textLink,
        fontSize: 14,
    },
    crumbs: {
        paddingVertical: 8,
    },
    crumbsInner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
    },
    crumbText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    crumbCurrent: {
        color: theme.colors.text,
        fontWeight: '600',
    },
    crumbSeparator: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        opacity: 0.6,
    },
    note: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        paddingHorizontal: 12,
        paddingVertical: 13,
    },
    loading: {
        paddingVertical: 18,
        alignItems: 'center',
    },
    hint: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 2,
    },
}));

/** Tappable breadcrumb: the root plus each segment, with the jump target. */
function breadcrumbs(path: string | undefined): { label: string; jump: string }[] {
    if (path === undefined) return [];
    const crumbs: { label: string; jump: string }[] = [{ label: '/', jump: '/' }];
    let acc = '';
    for (const segment of path.split('/').filter(Boolean)) {
        acc += `/${segment}`;
        crumbs.push({ label: segment, jump: `${acc}/` });
    }
    return crumbs;
}

function parentOf(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    return slash > 0 ? trimmed.slice(0, slash) : '/';
}

const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** A one-tap folder: an open workspace ("Open") or a recent one. */
export interface DirectoryPlace {
    path: string;
    note?: string;
}

interface DirectoryPickerProps {
    value: string;
    onChange: (path: string) => void;
    places: readonly DirectoryPlace[];
    room?: number;
    onFocus?: () => void;
    onBlur?: () => void;
}

export function DirectoryPicker({ value, onChange, places, room, onFocus, onBlur }: DirectoryPickerProps) {
    const { theme } = useUnistyles();
    const [browsing, setBrowsing] = React.useState(false);
    const [listing, setListing] = React.useState<Listing | undefined>(undefined);
    const [loading, setLoading] = React.useState(false);
    const [listFailed, setListFailed] = React.useState(false);
    const [exists, setExists] = React.useState<boolean | undefined>(undefined);
    const fetchSeq = React.useRef(0);
    const crumbsRef = React.useRef<ScrollView>(null);
    const inputRef = React.useRef<TextInput>(null);
    const [listY, setListY] = React.useState(0);
    // A browser moves focus to the tapped row, which closes the phone keyboard
    // after every step; hand focus back so completion keeps going.
    const typing = React.useRef(false);
    const holdFocus = () => {
        typing.current = inputRef.current?.isFocused() ?? false;
    };
    const browseTo = (path: string) => {
        onChange(path);
        if (typing.current) inputRef.current?.focus();
    };
    const finishBrowsing = () => {
        setBrowsing(false);
        inputRef.current?.blur();
    };

    const target = resolveListingTarget(value);

    // The listing follows the browser location; a failure keeps the last good one.
    React.useEffect(() => {
        if (!browsing) return;
        const seq = ++fetchSeq.current;
        setLoading(true);
        sync
            .request('machine.listDir', { path: target.listPath })
            .then((result) => {
                if (seq !== fetchSeq.current) return;
                setListing(result);
                setListFailed(false);
            })
            .catch(() => {
                if (seq === fetchSeq.current) setListFailed(true);
            })
            .finally(() => {
                if (seq === fetchSeq.current) setLoading(false);
            });
    }, [browsing, target.listPath]);

    // Debounced existence check of the typed path: nothing while typing/flighted.
    React.useEffect(() => {
        setExists(undefined);
        const trimmed = value.trim();
        if (trimmed === '') return;
        let live = true;
        const timer = setTimeout(() => {
            sync
                .request('machine.listDir', { path: trimmed })
                .then((result) => {
                    if (live) setExists(result.exists);
                })
                .catch(() => {
                    if (live) setExists(undefined);
                });
        }, EXISTENCE_DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [value]);

    // Keep the current segment in view as the browser descends.
    React.useEffect(() => {
        crumbsRef.current?.scrollToEnd({ animated: false });
    }, [listing?.path]);

    // Case-blind like the Mac's filesystem: `~/doc` still offers Documents.
    const prefix = target.prefix.toLowerCase();
    const rows = (listing?.entries ?? []).filter((entry) => entry.name.toLowerCase().startsWith(prefix));
    const crumbs = breadcrumbs(listing?.path);
    const listMaxHeight = room === undefined
        ? ROW_HEIGHT * MAX_VISIBLE_ROWS
        : Math.min(ROW_HEIGHT * MAX_VISIBLE_ROWS, Math.max(ROW_HEIGHT * 2, room - listY - 8));
    const shownPlaces = places.slice(0, MAX_PLACES);

    const listBody = loading && listing === undefined ? (
        <View style={styles.loading}>
            <ActivityIndicator color={theme.colors.textSecondary} />
        </View>
    ) : listFailed ? (
        <Text style={styles.note}>Folders can’t be listed here. You can still type a path.</Text>
    ) : rows.length === 0 ? (
        <Text style={styles.note}>
            {target.prefix === '' ? 'No folders inside.' : `No folders start with “${target.prefix}”.`}
        </Text>
    ) : (
        <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ maxHeight: listMaxHeight }}>
            {rows.map((entry, index) => (
                <Pressable
                    key={entry.name}
                    onPressIn={holdFocus}
                    onPress={() => browseTo(`${target.listPath}${entry.name}/`)}
                    accessibilityRole="button"
                    accessibilityLabel={entry.name}
                >
                    <View style={styles.row}>
                        <Ionicons name="folder" size={16} color={theme.colors.textSecondary} />
                        <Text numberOfLines={1} style={[styles.rowName, { flex: 1, maxWidth: undefined }]}>
                            {entry.name}
                        </Text>
                        {entry.repo && <Ionicons name="git-branch" size={14} color={theme.colors.textSecondary} />}
                    </View>
                    {index < rows.length - 1 && <View style={styles.rowHairline} />}
                </Pressable>
            ))}
        </ScrollView>
    );

    return (
        <View>
            <View style={styles.card}>
                <View style={styles.inputRow}>
                    <Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />
                    <TextInput
                        ref={inputRef}
                        value={value}
                        onChangeText={onChange}
                        onFocus={() => {
                            setBrowsing(true);
                            onFocus?.();
                        }}
                        onBlur={onBlur}
                        placeholder="Choose a folder"
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        accessibilityLabel="Folder"
                        style={styles.input}
                    />
                    {browsing ? (
                        <Pressable onPress={finishBrowsing} hitSlop={10} accessibilityRole="button">
                            <Text style={styles.done}>Done</Text>
                        </Pressable>
                    ) : exists === true ? (
                        <Ionicons name="checkmark" size={18} color={theme.colors.success} />
                    ) : null}
                </View>

                <View style={styles.hairline} />

                {browsing ? (
                    <View onLayout={({ nativeEvent }) => setListY(nativeEvent.layout.y)}>
                        {crumbs.length > 0 && (
                            <ScrollView
                                ref={crumbsRef}
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                style={styles.crumbs}
                            >
                                <View style={styles.crumbsInner}>
                                    {crumbs.map((crumb, index) => (
                                        <React.Fragment key={crumb.jump}>
                                            {index > 0 && <Text style={styles.crumbSeparator}>›</Text>}
                                            <Pressable
                                                onPressIn={holdFocus}
                                                onPress={() => browseTo(crumb.jump)}
                                                disabled={index === crumbs.length - 1}
                                                hitSlop={6}
                                            >
                                                <Text style={[styles.crumbText, index === crumbs.length - 1 && styles.crumbCurrent]}>
                                                    {crumb.label}
                                                </Text>
                                            </Pressable>
                                        </React.Fragment>
                                    ))}
                                </View>
                            </ScrollView>
                        )}
                        {crumbs.length > 0 && <View style={styles.hairline} />}
                        {listBody}
                    </View>
                ) : (
                    <View>
                        {shownPlaces.map((place) => {
                            const chosen = samePath(place.path, value);
                            return (
                                <Pressable
                                    key={place.path}
                                    onPress={() => onChange(place.path)}
                                    accessibilityRole="button"
                                    accessibilityLabel={basename(place.path)}
                                    accessibilityState={{ selected: chosen }}
                                >
                                    <View style={styles.row}>
                                        <Ionicons name="folder" size={16} color={theme.colors.textSecondary} />
                                        <View style={styles.rowTexts}>
                                            <Text numberOfLines={1} style={[styles.rowName, chosen && { fontWeight: '600' }]}>
                                                {basename(place.path)}
                                            </Text>
                                            <Text numberOfLines={1} style={styles.rowMeta}>
                                                {place.note ?? parentOf(place.path)}
                                            </Text>
                                        </View>
                                        {chosen && <Ionicons name="checkmark" size={16} color={theme.colors.textLink} />}
                                    </View>
                                    <View style={styles.rowHairline} />
                                </Pressable>
                            );
                        })}
                        <Pressable onPress={() => setBrowsing(true)} accessibilityRole="button">
                            <View style={styles.row}>
                                <Ionicons name="search" size={16} color={theme.colors.textLink} />
                                <Text style={styles.browseText}>Browse folders</Text>
                                <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                            </View>
                        </Pressable>
                    </View>
                )}
            </View>

            {!browsing && exists === false && (
                <Text style={styles.hint}>This folder doesn’t exist yet. You’ll be asked before it’s created.</Text>
            )}
        </View>
    );
}
