/**
 * Smart directory picker for the New-agent screen. The owner can still paste
 * a path blind (the input keeps working), but now gets a shell-completion-style
 * listing of the current browser location, repo glyphs, and an existence check
 * on the typed path. Listing data comes from the host's machine.listDir.
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
import { sync } from '@/sync/sync';
import type { RequestResult } from '@muxr/contract';
import { Text } from '@/components/StyledText';
import { basename, resolveListingTarget } from '@/utils/directoryPicker';

type Listing = RequestResult<'machine.listDir'>;

const EXISTENCE_DEBOUNCE_MS = 250;
const ROW_HEIGHT = 44;
const MAX_VISIBLE_ROWS = 7;

const styles = StyleSheet.create((theme) => ({
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 10,
        paddingLeft: 12,
        paddingRight: 10,
        gap: 8,
    },
    input: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 14,
        paddingVertical: 10,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 10,
    },
    chip: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    chipText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '500',
    },
    crumbs: {
        marginTop: 12,
        marginBottom: 6,
    },
    crumbsInner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 2,
    },
    crumbText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    crumbCurrent: {
        color: theme.colors.text,
        fontWeight: '700',
    },
    crumbSeparator: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        opacity: 0.6,
    },
    listWindow: {
        maxHeight: ROW_HEIGHT * MAX_VISIBLE_ROWS,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        height: ROW_HEIGHT,
        paddingHorizontal: 12,
    },
    rowName: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 14,
    },
    hairline: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 36,
    },
    emptyHint: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        paddingHorizontal: 12,
        paddingVertical: 14,
    },
    loading: {
        paddingVertical: 22,
        alignItems: 'center',
    },
    errorText: {
        color: theme.colors.deleteAction,
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

interface DirectoryPickerProps {
    value: string;
    onChange: (path: string) => void;
    recent: string[];
}

export function DirectoryPicker({ value, onChange, recent }: DirectoryPickerProps) {
    const { theme } = useUnistyles();
    const [listing, setListing] = React.useState<Listing | undefined>(undefined);
    const [loading, setLoading] = React.useState(false);
    const [listError, setListError] = React.useState<string | undefined>(undefined);
    const [exists, setExists] = React.useState<boolean | undefined>(undefined);
    const fetchSeq = React.useRef(0);
    const crumbsRef = React.useRef<ScrollView>(null);

    const target = resolveListingTarget(value);

    // The listing follows the browser location; an error keeps the last good one.
    React.useEffect(() => {
        const seq = ++fetchSeq.current;
        setLoading(true);
        sync
            .request('machine.listDir', { path: target.listPath })
            .then((result) => {
                if (seq !== fetchSeq.current) return;
                setListing(result);
                setListError(undefined);
            })
            .catch((error) => {
                if (seq !== fetchSeq.current) return;
                setListError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (seq === fetchSeq.current) setLoading(false);
            });
    }, [target.listPath]);

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

    const rows = (listing?.entries ?? []).filter(
        (entry) => target.prefix === '' || entry.name.startsWith(target.prefix),
    );
    const crumbs = breadcrumbs(listing?.path);

    return (
        <View>
            <View style={styles.inputRow}>
                <TextInput
                    value={value}
                    onChangeText={onChange}
                    placeholder="/home/you/project"
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                />
                {exists !== undefined && (
                    <Ionicons
                        name={exists ? 'checkmark-circle' : 'alert-circle'}
                        size={18}
                        color={exists ? theme.colors.success : theme.colors.deleteAction}
                    />
                )}
            </View>

            {recent.length > 0 && (
                <View style={styles.chips}>
                    {recent.map((recentPath) => (
                        <Pressable key={recentPath} onPress={() => onChange(recentPath)}>
                            <View style={styles.chip}>
                                <Text style={styles.chipText}>{basename(recentPath)}</Text>
                            </View>
                        </Pressable>
                    ))}
                </View>
            )}

            {listing !== undefined && (
                <ScrollView
                    ref={crumbsRef}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.crumbs}
                >
                    <View style={styles.crumbsInner}>
                        {crumbs.map((crumb, index) => (
                            <React.Fragment key={crumb.jump}>
                                {index > 0 && <Text style={styles.crumbSeparator}>›</Text>}
                                <Pressable
                                    onPress={() => onChange(crumb.jump)}
                                    disabled={index === crumbs.length - 1}
                                    hitSlop={6}
                                >
                                    <Text
                                        style={[
                                            styles.crumbText,
                                            index === crumbs.length - 1 && styles.crumbCurrent,
                                        ]}
                                    >
                                        {crumb.label}
                                    </Text>
                                </Pressable>
                            </React.Fragment>
                        ))}
                    </View>
                </ScrollView>
            )}

            <View style={styles.listWindow}>
                {loading ? (
                    <View style={styles.loading}>
                        <ActivityIndicator color={theme.colors.textSecondary} />
                    </View>
                ) : rows.length === 0 ? (
                    <Text style={styles.emptyHint}>No directories here.</Text>
                ) : (
                    <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                        {rows.map((entry, index) => (
                            <Pressable
                                key={entry.name}
                                onPress={() => onChange(`${target.listPath}${entry.name}/`)}
                            >
                                <View style={styles.row}>
                                    <Ionicons name="folder" size={16} color={theme.colors.textSecondary} />
                                    <Text numberOfLines={1} style={styles.rowName}>
                                        {entry.name}
                                    </Text>
                                    {entry.repo && (
                                        <Ionicons name="git-branch" size={14} color={theme.colors.success} />
                                    )}
                                </View>
                                {index < rows.length - 1 && <View style={styles.hairline} />}
                            </Pressable>
                        ))}
                    </ScrollView>
                )}
            </View>

            {listError !== undefined && <Text style={styles.errorText}>{listError}</Text>}
        </View>
    );
}
