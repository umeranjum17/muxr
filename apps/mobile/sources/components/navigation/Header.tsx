import * as React from 'react';
import { Animated, View, Text, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { BlurView } from 'expo-blur';
import { layout } from '@/components/layout';
import { useCompactWindow } from '@/components/useCompactWindow';
import { isRunningOnMac } from '@/utils/platform';
import { useHeaderHeight, useIsTablet, useSplitViewLayout } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { WordWrappingText } from '@/components/WordWrappingText';
import { HeaderBackButton } from '@/components/navigation/HeaderBackButton';
import {
    MOBILE_GLASS_CONTROL_RADIUS,
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_GLASS_HEADER_HEIGHT,
} from '@/components/navigation/headerMetrics';

const isDesktop = Platform.OS === 'web' || isRunningOnMac();

interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: (() => React.ReactNode) | null;
    headerLeftGlass?: boolean;
    headerRight?: (() => React.ReactNode) | null;
    headerRightGlass?: boolean;
    headerRightTouchInset?: boolean;
    compactHorizontalPadding?: boolean;
    headerStyle?: any;
    headerTitleStyle?: any;
    headerSubtitleStyle?: any;
    headerTintColor?: string;
    headerBackgroundColor?: string;
    headerShadowVisible?: boolean;
    headerTransparent?: boolean;
    headerBackdropVisible?: boolean;
    safeAreaEnabled?: boolean;
}

export const Header = React.memo((props: HeaderProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const {
        title,
        subtitle,
        headerLeft,
        headerLeftGlass = false,
        headerRight,
        headerRightGlass = true,
        headerRightTouchInset = false,
        compactHorizontalPadding = false,
        headerStyle,
        headerTitleStyle,
        headerSubtitleStyle,
        headerTintColor, // Accept but ignore - using theme instead
        headerBackgroundColor, // Accept but ignore - using theme instead
        headerShadowVisible = true,
        headerTransparent = false,
        headerBackdropVisible = false,
        safeAreaEnabled = true,
    } = props;

    const insets = useSafeAreaInsets();
    const paddingTop = safeAreaEnabled ? insets.top : 0;
    const headerHeight = useHeaderHeight();
    const isTablet = useIsTablet();
    const floatingControlsEnabled = !isDesktop && !isTablet;
    const headerLeftUsesGlass = headerLeftGlass && !isDesktop;
    const headerRightUsesGlass = headerRightGlass && !isDesktop;
    const contentHeight = floatingControlsEnabled ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT) : headerHeight;
    const backdropOpacity = React.useRef(new Animated.Value(headerBackdropVisible ? 1 : 0)).current;
    const [backdropMounted, setBackdropMounted] = React.useState(headerBackdropVisible);

    React.useEffect(() => {
        if (headerBackdropVisible) {
            setBackdropMounted(true);
        }
        Animated.timing(backdropOpacity, {
            toValue: headerBackdropVisible ? 1 : 0,
            duration: 160,
            useNativeDriver: true,
        }).start(({ finished }) => {
            if (finished && !headerBackdropVisible) {
                setBackdropMounted(false);
            }
        });
    }, [backdropOpacity, headerBackdropVisible]);

    const containerStyle = [
        styles.container,
        headerTransparent && styles.containerTransparent,
        !headerTransparent && styles.containerNormal,
        {
            paddingTop,
        },
        headerShadowVisible && styles.shadow,
        headerStyle,
        !isDesktop && styles.containerTransparent,
    ];

    const subtitleStyle = [
        styles.subtitle,
        isDesktop && styles.desktopSubtitle,
        headerSubtitleStyle,
    ];

    return (
        <View style={containerStyle}>
            {floatingControlsEnabled && backdropMounted && (
                <Animated.View
                    pointerEvents="none"
                    style={[styles.headerBlur, { opacity: backdropOpacity }]}
                >
                    <BlurView
                        blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                        blurReductionFactor={2}
                        intensity={34}
                        tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                        style={styles.headerBlurFill}
                    />
                </Animated.View>
            )}
            <View style={styles.contentWrapper}>
                <View style={[styles.content, isDesktop && styles.desktopContent, compactHorizontalPadding && styles.compactContent, { minHeight: contentHeight }]}>
                    <View style={styles.leftContainer}>
                        {headerLeft && headerLeftUsesGlass && (
                            <MobileGlassSurface
                                enabled={floatingControlsEnabled}
                                interactive
                                intensity={76}
                                style={styles.leftControlGlass}
                            >
                                <View style={styles.leftControlContent}>
                                    {headerLeft()}
                                </View>
                            </MobileGlassSurface>
                        )}
                        {headerLeft && !headerLeftUsesGlass && headerLeft()}
                    </View>

                    <View style={[
                        styles.centerContainer,
                        isDesktop && styles.desktopCenterContainer,
                        compactHorizontalPadding && styles.compactCenterContainer,
                    ]}>
                        {typeof title === 'string'
                            // A block of its own: the web row would size the title to its scaled text.
                            ? <View style={styles.titleBlock}>
                                <WordWrappingText fontSize={16} style={[styles.title, headerTitleStyle]} numberOfLines={3}>{title}</WordWrappingText>
                            </View>
                            : title}
                        {subtitle && <Text style={subtitleStyle} numberOfLines={1} ellipsizeMode="tail">{subtitle}</Text>}
                    </View>

                    <View style={[styles.rightContainer, headerRightTouchInset && styles.rightContainerTouchInset]}>
                        {headerRight && headerRightUsesGlass && (
                            <MobileGlassSurface
                                enabled={floatingControlsEnabled}
                                interactive
                                intensity={76}
                                style={styles.rightControlGlass}
                            >
                                <View style={styles.rightControlContent}>
                                    {headerRight()}
                                </View>
                            </MobileGlassSurface>
                        )}
                        {headerRight && !headerRightUsesGlass && headerRight()}
                    </View>
                </View>
            </View>
        </View>
    );
});

// Extended navigation options to support subtitle
interface ExtendedNavigationOptions extends Partial<NativeStackHeaderProps['options']> {
    headerSubtitle?: string;
    headerSubtitleStyle?: any;
}

const DefaultBackButton: React.FC<{ tintColor?: string; onPress: () => void }> = ({ tintColor, onPress }) => <HeaderBackButton onPress={onPress} color={tintColor} />;

// Component wrapper for navigation header
const NavigationHeaderComponent: React.FC<NativeStackHeaderProps> = React.memo((props) => {
    const { options, route, back, navigation } = props;
    const extendedOptions = options as ExtendedNavigationOptions;
    const splitViewLayout = useSplitViewLayout();
    const compact = useCompactWindow();

    // The permanent split-view header owns Back only while the drawer is present.
    const shouldHideBackButton = splitViewLayout;

    // Extract title - handle both string and function types. String titles
    // wrap to a second line inside the shrinking center container so a
    // 270 dp / font-2.0 phone reads them whole and never pushes them past the
    // right edge; only a title longer than two lines ellipsizes.
    const titleTextStyle = (fontSize: number) => [
        {
            fontSize,
            fontWeight: '600' as const,
            textAlign: (isDesktop && Platform.OS === 'ios' ? 'center' : 'left') as 'center' | 'left',
            color: options.headerTintColor || '#000',
            flexShrink: 1,
            minWidth: 0,
            maxWidth: '100%' as const,
        },
        Typography.default('semiBold'),
        options.headerTitleStyle,
    ];
    // Only a roomy desktop row keeps 17; compact rows and native use 16.
    const stringTitleFontSize = isDesktop && !compact ? 17 : 16;
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = (
                <Text style={titleTextStyle(stringTitleFontSize)} numberOfLines={2} ellipsizeMode="tail">
                    {options.headerTitle}
                </Text>
            );
        } else if (typeof options.headerTitle === 'function') {
            // Handle function type headerTitle
            title = options.headerTitle({ children: route.name, tintColor: options.headerTintColor });
        }
    } else if (typeof options.title === 'string') {
        title = (
            <Text style={titleTextStyle(17)} numberOfLines={2} ellipsizeMode="tail">
                {options.title}
            </Text>
        );
    }

    // Determine header left content
    let headerLeftContent: (() => React.ReactNode) | undefined | null = null;
    if (options.headerLeft) {
        // Use custom headerLeft if provided
        headerLeftContent = () => options.headerLeft!({ canGoBack: !!back, tintColor: options.headerTintColor });
    } else if (back && options.headerBackVisible !== false && !shouldHideBackButton) {
        // Show default back button if can go back and not explicitly hidden
        // Also hide on tablet when at first or second screen
        headerLeftContent = () => (
            <DefaultBackButton
                tintColor={options.headerTintColor}
                onPress={() => navigation.goBack()}
            />
        );
    }

    return (
        <Header
            title={title}
            subtitle={extendedOptions.headerSubtitle}
            headerLeft={headerLeftContent}
            headerRight={options.headerRight ?
                () => options.headerRight!({ canGoBack: !!back, tintColor: options.headerTintColor }) :
                undefined
            }
            compactHorizontalPadding={compact}
            headerStyle={options.headerStyle}
            headerTitleStyle={options.headerTitleStyle}
            headerSubtitleStyle={extendedOptions.headerSubtitleStyle}
            headerShadowVisible={options.headerShadowVisible}
            headerTransparent={options.headerTransparent}
        />
    );
});

// Export a render function for React Navigation
export const createHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <NavigationHeaderComponent {...props} />;
};

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    containerTransparent: {
        backgroundColor: 'transparent',
    },
    containerNormal: {
        backgroundColor: theme.colors.header.background,
    },
    headerBlur: {
        ...StyleSheet.absoluteFillObject,
    },
    headerBlurFill: {
        ...StyleSheet.absoluteFillObject,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: Platform.OS === 'web' ? 0 : 8,
        paddingHorizontal: Platform.OS === 'web' ? 16 : 12,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
    },
    compactContent: { paddingHorizontal: 6 },
    desktopContent: {
        gap: 0,
        paddingHorizontal: Platform.select({ ios: 8, default: 16 }),
    },
    leftContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-start',
    },
    centerContainer: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        alignSelf: 'stretch',
        flexDirection: Platform.OS === 'web' ? 'row' : 'column',
        alignItems: Platform.OS === 'web' ? 'center' : 'flex-start',
        justifyContent: Platform.OS === 'web' ? 'flex-start' : 'center',
        paddingHorizontal: Platform.OS === 'web' ? 12 : 0,
        // Flex children default to min-content width; without 0 the title can
        // refuse to shrink and run past the right edge at 270 dp / font 2.0.
        minWidth: 0,
    },
    // Drop the web-only title gutter when the row is already tight so short
    // titles like Accounts still fit whole at 270 dp / font 2.0.
    compactCenterContainer: {
        paddingHorizontal: 0,
    },
    desktopCenterContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: Platform.OS === 'ios' ? 'center' : 'flex-start',
        paddingHorizontal: 12,
        minWidth: 0,
    },
    titleBlock: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center' },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
        flexShrink: 1,
        minWidth: 0,
    },
    rightContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-end',
    },
    rightContainerTouchInset: { paddingHorizontal: 4, marginHorizontal: -4 },
    rightControlGlass: {
        minWidth: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
    leftControlGlass: {
        width: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        height: Platform.select({ web: 36, default: MOBILE_GLASS_CONTROL_SIZE }),
        borderRadius: MOBILE_GLASS_CONTROL_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: Platform.select({
            web: 'transparent',
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: 'transparent',
        }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.glass.shadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: Platform.select({ web: 0, default: 1 }),
        shadowRadius: 18,
        elevation: Platform.select({ android: 8, default: 0 }),
    },
    leftControlContent: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    rightControlContent: {
        minHeight: Platform.select({ web: 0, default: MOBILE_GLASS_CONTROL_SIZE }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: Platform.select({ web: 0, default: 6 }),
    },
    subtitle: {
        fontSize: Platform.OS === 'web' ? 13 : 12,
        fontWeight: '400',
        textAlign: 'left',
        marginTop: Platform.OS === 'web' ? 2 : 1,
        color: theme.colors.header.tint,
        flexShrink: 1,
        maxWidth: '100%',
        ...Typography.default('regular'),
    },
    desktopSubtitle: {
        fontSize: 13,
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        marginTop: 2,
    },
    shadow: {
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 3,
        elevation: 4,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
    },
}));
