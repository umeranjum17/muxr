import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { OptionSheet } from '@/components/OptionSheet';
import { t } from '@/text';
import { withAlpha } from '@/components/ui';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export interface PathBreadcrumbSegment {
    label: string;
    onPress?: () => void;
    icon?: IconName;
}

export function PathBreadcrumb({
    segments,
    fullPath,
    inline = false,
    trailing,
}: {
    segments: PathBreadcrumbSegment[];
    fullPath?: string;
    inline?: boolean;
    trailing?: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const trail = React.useRef<ScrollView>(null);
    const [showFullPath, setShowFullPath] = React.useState(false);
    const path = fullPath ?? segments.map((segment) => segment.label).join('/');
    const visibleSegments = React.useMemo<PathBreadcrumbSegment[]>(() => {
        if (segments.length <= 4) return segments;
        return [segments[0]!, { label: '…' }, ...segments.slice(-3)];
    }, [segments]);
    const openFullPath = React.useCallback(() => setShowFullPath(true), []);
    const copyPath = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(path);
            setShowFullPath(false);
            Modal.alert(t('common.copied'), path);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        }
    }, [path]);

    return (
        <>
            <View accessible={false} style={{ height: 44, minHeight: 44, flexDirection: 'row', backgroundColor: inline ? 'transparent' : theme.colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }}>
                <ScrollView ref={trail} horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center' }}
                    onContentSizeChange={() => trail.current?.scrollToEnd({ animated: true })}>
                    {visibleSegments.map((segment, index) => {
                        const isLast = index === visibleSegments.length - 1;
                        const isEllipsis = segment.label === '…';
                        const onPress = isEllipsis ? openFullPath : segment.onPress ?? openFullPath;
                        return (
                            <React.Fragment key={`${segment.label}:${index}`}>
                                {index > 0 && <Text accessible={false} style={{ color: withAlpha(theme.colors.textSecondary, 0.45), fontSize: 12, paddingHorizontal: 6, ...Typography.mono() }}>/</Text>}
                                <Pressable onPress={onPress} onLongPress={openFullPath} accessibilityRole="button"
                                    accessibilityLabel={isEllipsis ? 'Show full path' : segment.onPress === undefined ? `Path ${segment.label}, show full path` : `Go to ${segment.label}`}
                                    style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: index === 0 && segment.icon !== undefined ? 5 : 0, paddingHorizontal: 8, backgroundColor: pressed ? theme.colors.surfaceHighest : 'transparent' })}>
                                    {index === 0 && segment.icon !== undefined && <MaterialCommunityIcons name={segment.icon} size={16} color={theme.colors.textSecondary} />}
                                    <Text numberOfLines={1} style={{ maxWidth: 220, color: isLast ? theme.colors.text : theme.colors.textSecondary, fontSize: 12, lineHeight: 16, ...Typography.mono(isLast ? 'semiBold' : 'regular') }}>{segment.label}</Text>
                                </Pressable>
                            </React.Fragment>
                        );
                    })}
                </ScrollView>
                {trailing !== undefined && <View style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}>{trailing}</View>}
            </View>
            <OptionSheet visible={showFullPath} title="Full path" options={[]} onSelect={() => {}} onClose={() => setShowFullPath(false)}
                body={<View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 12 }}>
                    <Text selectable style={{ color: theme.colors.text, fontSize: 13, lineHeight: 20, ...Typography.mono() }}>{path}</Text>
                    <Pressable onPress={() => void copyPath()} accessibilityRole="button" accessibilityLabel={t('common.copy')}
                        style={({ pressed }) => ({ minHeight: 44, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 })}>
                        <MaterialCommunityIcons name="content-copy" size={16} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') }}>{t('common.copy')}</Text>
                    </Pressable>
                </View>} />
        </>
    );
}
