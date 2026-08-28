import * as React from 'react';
import { ActivityIndicator, View, Text, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { PluginSlot } from '@/plugins/ui';
import { pluginCatalogLoaded, pluginSnapshot, pluginUnavailableReason } from '@/plugins';
import { resolvePluginText } from '@/plugins';
import { useSlotContributions } from '@/plugins';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Header } from '@/components/navigation/Header';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import { parsePluginScreenParams } from '@muxr/contract';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 16,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 15,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

export default function PluginPage() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { pluginId, contentId, params } = useLocalSearchParams<{ pluginId?: string; contentId?: string; params?: string }>();
    const navigationContributions = useSlotContributions('navigation.content');
    const selected = typeof pluginId === 'string' && pluginId !== '' && typeof contentId === 'string' && contentId !== '';
    const available = selected && navigationContributions.some((contribution) => contribution.pluginId === pluginId && contribution.id === contentId);
    const title = selected ? mountTitle(pluginId, contentId) : '';
    const screenParams = React.useMemo(() => {
        if (typeof params !== 'string' || params.length === 0) return undefined;
        try {
            const parsed: unknown = JSON.parse(params);
            return parsePluginScreenParams(parsed);
        } catch {
            return undefined;
        }
    }, [params]);
    const loaded = pluginCatalogLoaded();
    const content = !selected
        ? <View style={styles.empty}><Text style={styles.emptyText}>{t('plugins.openFromHome')}</Text></View>
        : !loaded
          ? <View style={styles.empty}><ActivityIndicator color={theme.colors.textSecondary} accessibilityLabel={t('plugins.waitingHost')} /><Text style={[styles.emptyText, { marginTop: 12 }]}>{t('plugins.waitingHost')}</Text></View>
        : !available
          ? <View style={styles.empty}>
              <Text style={styles.emptyText}>{pluginUnavailableReason(pluginId) ?? t('plugins.unavailable')}</Text>
              <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('plugins.goBack')} style={{ padding: 16 }}>
                  <Text style={{ color: theme.colors.textLink, ...Typography.default('semiBold') }}>{t('plugins.goBack')}</Text>
              </Pressable>
          </View>
          : <PluginSlot slot="navigation.content" context={{ pluginId, contributionId: contentId, ...(screenParams === undefined ? {} : { params: screenParams }) }} />;

    return (
        <View style={styles.container}>
            <Header
                title={<Text style={styles.headerTitle}>{title}</Text>}
                headerLeft={() => <HeaderBackButton onPress={() => router.back()} label={t('plugins.goBack')} />}
                headerLeftGlass={false}
                headerShadowVisible={false}
                headerTransparent
            />
            {content}
        </View>
    );
}

function mountTitle(pluginId: string, contentId: string): string {
    const entry = pluginSnapshot().find((item) => item.summary.pluginId === pluginId);
    if (entry === undefined) return '';
    const nav = entry.manifest.contributions.find((contribution) =>
        'type' in contribution && contribution.type === 'navigation-item' && contribution.contentContributionId === contentId);
    return nav !== undefined && 'label' in nav ? resolvePluginText(nav.label) : entry.summary.name;
}
