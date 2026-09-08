import React, { useEffect } from 'react';
import { Platform, ScrollView, View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ChangelogChange, ChangelogRelease, ChangelogVerification, currentRelease, getLegacyEntries, olderReleases, setLastViewedRelease } from '@/changelog';
import { getAppVersion } from '@/utils/appVersion';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { MobileGlassSurface } from '@/components/MobileGlass';

const statusLabels: Record<ChangelogVerification['status'], string> = {
    passed: 'Passed',
    partial: 'Partial',
    failed: 'Failed',
    'not-run': 'Not run',
};

function Card({ children }: { children: React.ReactNode }) {
    return (
        <MobileGlassSurface enabled={Platform.OS !== 'web'} intensity={64} style={styles.card}>
            {children}
        </MobileGlassSurface>
    );
}

function Section({ title, changes }: { title: string; changes: ChangelogChange[] }) {
    if (changes.length === 0) return null;
    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <Card>
                {changes.map((change) => (
                    <View key={change.title} style={styles.changeContainer}>
                        <Text style={styles.changeTitle}>{change.title}</Text>
                        <Text style={styles.changeDetail}>{change.detail}</Text>
                    </View>
                ))}
            </Card>
        </View>
    );
}

function Release({ release }: { release: ChangelogRelease }) {
    return (
        <View style={styles.entryContainer}>
            <Text style={styles.versionText}>{`App version ${release.appVersion}`}</Text>
            <Text style={styles.titleText}>{release.title}</Text>
            <Text style={styles.summaryText}>{release.summary}</Text>
            <Section title="Added" changes={release.features} />
            <Section title="Fixed" changes={release.fixes} />
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Verification</Text>
                <Card>
                    {release.verification.length === 0 ? (
                        <Text style={styles.changeDetail}>No verification recorded.</Text>
                    ) : release.verification.map((item) => (
                        <View key={item.title} style={styles.changeContainer}>
                            <Text style={styles.changeTitle}>{`${statusLabels[item.status]} · ${item.title}`}</Text>
                            <Text style={styles.changeDetail}>{item.detail}</Text>
                            {item.evidence ? (
                                <Text style={styles.evidenceText}>
                                    {`${item.evidence.environment} · ${item.evidence.testedCommit} · ${item.evidence.checkedBy} · ${item.evidence.checkedAt}${item.evidence.path ? ` · ${item.evidence.path}` : ''}`}
                                </Text>
                            ) : null}
                        </View>
                    ))}
                </Card>
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Known limits</Text>
                <Card>
                    {release.knownLimits.length === 0 ? (
                        <Text style={styles.changeDetail}>No additional limits recorded.</Text>
                    ) : release.knownLimits.map((limit) => (
                        <Text key={limit} style={styles.limitText}>{`• ${limit}`}</Text>
                    ))}
                </Card>
            </View>
        </View>
    );
}

export default function ChangelogScreen() {
    const insets = useSafeAreaInsets();
    const release = currentRelease();
    const previous = olderReleases(getAppVersion());
    const legacy = getLegacyEntries();

    useEffect(() => {
        if (release) setLastViewedRelease(release.appVersion);
    }, [release]);

    if (!release && previous.length === 0 && legacy.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyState}>
                    <Text style={styles.emptyText}>{t('changelog.noEntriesAvailable')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ScrollView
                style={styles.container}
                contentContainerStyle={[
                    styles.content,
                    {
                        paddingBottom: insets.bottom + 40,
                        maxWidth: layout.maxWidth,
                        alignSelf: 'center',
                        width: '100%'
                    }
                ]}
                showsVerticalScrollIndicator={false}
            >
                {release ? <Release release={release} /> : null}

                {previous.length > 0 ? <Text style={styles.sectionTitle}>Earlier releases</Text> : null}
                {previous.map((entry) => <Release key={entry.appVersion} release={entry} />)}

                {legacy.length > 0 ? <Text style={styles.sectionTitle}>Earlier updates</Text> : null}
                {legacy.map((entry) => (
                    <View key={entry.title} style={styles.entryContainer}>
                        <Text style={styles.titleText}>{entry.title}</Text>
                        {entry.summary ? <Text style={styles.summaryText}>{entry.summary}</Text> : null}
                        {entry.markdown ? (
                            <Card>
                                <MarkdownView markdown={entry.markdown} />
                            </Card>
                        ) : null}
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    entryContainer: {
        marginBottom: 32,
    },
    section: {
        marginTop: 16,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    versionText: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    titleText: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 28,
        color: theme.colors.text,
        marginBottom: 8,
    },
    summaryText: {
        ...Typography.default('regular'),
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginBottom: 16,
    },
    changeContainer: {
        marginBottom: 12,
    },
    changeTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.text,
    },
    changeDetail: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
    evidenceText: {
        ...Typography.default('regular'),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
    limitText: {
        ...Typography.default('regular'),
        fontSize: 14,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        marginBottom: 6,
    },
    card: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
        borderRadius: Platform.select({ web: 12, default: 20 }),
        padding: 16,
        overflow: 'hidden',
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 20,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    emptyText: {
        ...Typography.default('regular'),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    }
}));
