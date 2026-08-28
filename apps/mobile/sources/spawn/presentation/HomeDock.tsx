import * as React from 'react';
import { ActivityIndicator, Keyboard, Modal as RNModal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { OptionSheet } from '@/components/OptionSheet';
import { BubblePressable } from '@/components/BubblePressable';
import { NativeSettingsMenu } from '@/settings';
import type { NativeSettingsMenuGroup } from '@/settings';
import { AgentInputAttachmentStrip } from '@/terminal/ui';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { useNewSessionDraft } from '../application/useNewSessionDraft';
import { PluginSlot } from '@/plugins/ui';
import { useAllMachines, useSessions, useSocketStatus } from '@/catalog/store';
import { isMachineOnline } from '@/pairing';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { listWorktrees } from '../infrastructure/worktree';
import { type NewSessionAgentType } from '@/catalog/application/persistence';
import { useImagePicker } from '@/hooks/useImagePicker';
import { sync } from '@/catalog/sync';
import { resolveAgentCatalog } from '@/catalog';
import {
    applyWorktreeSelection,
    agentTypeIfHostDisallows,
    currentDockAgent,
    machineDockOptions,
    projectDockOptions,
    resolveDockOption,
    selectedWorktreeKey,
    visibleDockAgents,
    worktreeDockOptions,
    type DockOption,
} from '../application/homeDockEnvironment';

export const MOBILE_HOME_DOCK_CONTENT_INSET = 108;

type EnvironmentSetting = 'machine' | 'project' | 'worktree' | 'agent';

const styles = StyleSheet.create((theme) => ({
    keyboardFollower: {
        width: '100%',
    },
    safeArea: {
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    composerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: 56,
        alignSelf: 'center',
        borderRadius: 28,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    composerContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 7,
        gap: 4,
    },
    sideButton: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sideButtonPressed: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    liveVoiceButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 3,
        backgroundColor: theme.colors.surfaceHighest,
    },
    liveVoiceButtonActive: {
        backgroundColor: theme.colors.status.error,
    },
    input: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        paddingHorizontal: 4,
        paddingVertical: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    inputEntry: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    inputEntryText: {
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    inputEntryPlaceholder: {
        color: theme.colors.textSecondary,
    },
    focusedComposerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: 126,
        alignSelf: 'center',
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    focusedComposerSurfaceWithAttachments: {
        height: 206,
    },
    focusedComposerAnimationShell: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: 30,
        overflow: 'hidden',
    },
    focusedComposerAnchored: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusedComposerContent: {
        flex: 1,
        paddingHorizontal: 10,
        paddingTop: 10,
        paddingBottom: 8,
    },
    focusedInput: {
        flex: 1,
        minHeight: 58,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
        color: theme.colors.text,
        fontSize: 18,
        textAlignVertical: 'top',
        ...Typography.default(),
    },
    focusedInputReveal: {
        flex: 1,
        minHeight: 0,
    },
    focusedComposerActions: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    focusedModeButton: {
        width: '100%',
        minWidth: 0,
        height: 40,
        paddingHorizontal: 8,
        borderRadius: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingRight: 0,
        gap: 7,
    },
    nativeGearMenu: {
        width: 42,
        height: 42,
    },
    nativeModeMenu: {
        flex: 1,
        minWidth: 0,
        height: 40,
    },
    nativeEffortMenu: {
        width: 64,
        flexShrink: 0,
        height: 40,
    },
    focusedEffortButton: {
        width: '100%',
        height: 40,
        paddingLeft: 2,
        paddingRight: 0,
        borderRadius: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 4,
    },
    focusedModeText: {
        flexShrink: 1,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    focusedModeSeparator: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        ...Typography.default(),
    },
    sendButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    focusedSendButton: {
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.fab.background,
    },
    modalRoot: {
        flex: 1,
    },
    modalBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusBackdrop: {
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
    },
    focusBackPosition: {
        position: 'absolute',
        left: 20,
    },
    focusBackSurface: {
        width: 52,
        height: 52,
        borderRadius: 26,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
    },
    focusBackButton: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    focusDock: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusConfig: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 24,
        paddingBottom: 10,
        gap: 8,
    },
    focusConfigGroup: {
        gap: 1,
    },
    focusConfigRevealRow: {
        width: '100%',
    },
    focusInlineSurface: {
        maxHeight: 220,
    },
    focusConfigRow: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 6,
        borderRadius: 12,
    },
    focusConfigIcon: {
        width: 24,
        alignItems: 'center',
    },
    focusConfigValue: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    focusConfigChevron: {
        width: 16,
        alignItems: 'center',
        gap: -5,
    },
    focusComposerArea: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    settingsPosition: {
        position: 'absolute',
        left: 16,
        right: 16,
    },
    settingsStack: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        gap: 10,
    },
    settingsSurface: {
        width: '100%',
        maxHeight: 270,
        borderRadius: 24,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: theme.colors.glass.overlay,
            default: theme.colors.glass.backgroundStrong,
        }),
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    settingsHeader: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingBottom: 4,
    },
    backButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    optionList: {
        flexGrow: 0,
    },
    option: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 14,
    },
    optionPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    optionCopy: {
        flex: 1,
        minWidth: 0,
    },
    optionLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
    optionValue: {
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default(),
    },
    optionDescription: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 2,
        ...Typography.default(),
    },
}));


function FocusConfigRevealRow({
    progress,
    index,
    children,
}: {
    progress: SharedValue<number>;
    index: number;
    children: React.ReactNode;
}) {
    const revealStyle = useAnimatedStyle(() => {
        const start = 0.18 + index * 0.09;
        const end = start + 0.28;
        const reveal = interpolate(
            progress.value,
            [start, end],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 10 * (1 - reveal) }],
        };
    }, [index]);

    return (
        <Animated.View style={[styles.focusConfigRevealRow, revealStyle]}>
            {children}
        </Animated.View>
    );
}

export const HomeDock = React.memo(({
    prompt,
    onPromptChange,
    onSubmit,
    isSubmitting,
}: {
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => Promise<boolean>;
    isSubmitting: boolean;
}) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const inputRef = React.useRef<TextInput>(null);
    const focusedInputRef = React.useRef<TextInput>(null);
    const focusAnimationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusPresentation = useSharedValue(0);
    const [isFocused, setIsFocused] = React.useState(false);
    const [focusModeVisible, setFocusModeVisible] = React.useState(false);
    const [openSheet, setOpenSheet] = React.useState<EnvironmentSetting | null>(null);
    const promptRef = React.useRef(prompt);
    promptRef.current = prompt;
    const composerDraft = React.useMemo(() => ({
        getText: () => promptRef.current,
        setText: onPromptChange,
    }), [onPromptChange]);
    const { selectedImages, pickImages, removeImage, clearImages } = useImagePicker();
    const agentType = useNewSessionDraft((state) => state.agentType);
    const selectedMachineId = useNewSessionDraft((state) => state.selectedMachineId);
    const selectedPath = useNewSessionDraft((state) => state.selectedPath);
    const sessionType = useNewSessionDraft((state) => state.sessionType);
    const worktreeKey = useNewSessionDraft((state) => state.worktreeKey);
    const setMachineId = useNewSessionDraft((state) => state.setMachineId);
    const setAgentType = useNewSessionDraft((state) => state.setAgentType);
    const setPath = useNewSessionDraft((state) => state.setPath);
    const setSessionType = useNewSessionDraft((state) => state.setSessionType);
    const setWorktreeKey = useNewSessionDraft((state) => state.setWorktreeKey);
    const socketStatus = useSocketStatus();
    const [hostAgentKinds, setHostAgentKinds] = React.useState<string[] | null>(null);
    const [hostAgentKindsAuthoritative, setHostAgentKindsAuthoritative] = React.useState(false);
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === selectedMachineId) ?? null,
        [machines, selectedMachineId],
    );
    const machineOptions = React.useMemo(() => machineDockOptions(machines), [machines]);
    const currentMachine = resolveDockOption(machineOptions, [selectedMachineId]);

    React.useEffect(() => {
        if (!selectedMachineId && machineOptions[0]) {
            setMachineId(machineOptions[0].key);
        }
    }, [machineOptions, selectedMachineId, setMachineId]);

    const projectOptions = React.useMemo(() => projectDockOptions({
        selectedPath,
        selectedMachineId,
        sessions,
        homeDir: selectedMachine?.metadata?.homeDir,
    }), [selectedMachine, selectedMachineId, selectedPath, sessions]);
    const currentProject = resolveDockOption(projectOptions, [selectedPath, '~']);
    const worktreeSelectionKey = selectedWorktreeKey(sessionType, worktreeKey);
    const [existingWorktrees, setExistingWorktrees] = React.useState<DockOption[]>([]);

    React.useEffect(() => {
        const path = resolveAbsolutePath(selectedPath ?? '~', selectedMachine?.metadata?.homeDir);
        if (!selectedMachineId || !selectedMachine || !isMachineOnline(selectedMachine) || !path) {
            setExistingWorktrees([]);
            return;
        }

        let cancelled = false;
        listWorktrees(selectedMachineId, path).then((worktrees) => {
            if (cancelled) return;
            setExistingWorktrees(worktrees.map((worktree) => ({
                key: worktree.path,
                name: worktree.branch,
                description: worktree.path,
            })));
        });
        return () => {
            cancelled = true;
        };
    }, [selectedMachine, selectedMachineId, selectedPath]);

    const worktreeOptions = React.useMemo(
        () => worktreeDockOptions(existingWorktrees, worktreeKey),
        [existingWorktrees, worktreeKey],
    );
    const currentWorktree = resolveDockOption(worktreeOptions, [worktreeSelectionKey]);
    React.useEffect(() => {
        let cancelled = false;
        setHostAgentKinds(null);
        setHostAgentKindsAuthoritative(false);
        if (socketStatus.status !== 'connected') return () => { cancelled = true; };
        void sync.request('herdr.agentKinds', {}).then((result) => {
            if (cancelled) return;
            const resolved = resolveAgentCatalog(result);
            const launchable = resolved.options
                .filter((option) => option.availability !== 'unavailable')
                .map((option) => option.kind);
            setHostAgentKinds([...new Set(['shell', ...launchable])]);
            setHostAgentKindsAuthoritative(resolved.authoritative);
        }).catch(() => {
            if (!cancelled) {
                setHostAgentKinds(null);
                setHostAgentKindsAuthoritative(false);
            }
        });
        return () => { cancelled = true; };
    }, [socketStatus.status]);
    const availableAgents = visibleDockAgents(hostAgentKinds, hostAgentKindsAuthoritative, agentType);
    const currentAgent = currentDockAgent(availableAgents, agentType);
    const canSubmit = !isSubmitting && (prompt.trim().length > 0 || selectedImages.length > 0);
    const focusedComposerHeight = selectedImages.length > 0 ? 206 : 126;
    const keyboardStyle = useAnimatedStyle(() => ({
        // Keyboard height includes the bottom safe area on iOS. The resting
        // dock keeps that inset, then gives it back while the keyboard opens
        // so the composer stays the same 8px above either boundary.
        transform: [{
            translateY: keyboard.height.value + safeArea.bottom * keyboard.progress.value,
        }],
    }), [safeArea.bottom]);
    const focusBackdropStyle = useAnimatedStyle(() => ({
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.35, 1],
            [0, 1, 1],
            Extrapolation.CLAMP,
        ),
    }));
    const focusBackButtonStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.12, 0.52],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [
                { translateY: -8 * (1 - reveal) },
                { scale: 0.94 + 0.06 * reveal },
            ],
        };
    });
    const focusedComposerAnimationStyle = useAnimatedStyle(() => ({
        height: interpolate(
            focusPresentation.value,
            [0, 1],
            [56, focusedComposerHeight],
            Extrapolation.CLAMP,
        ),
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.12, 1],
            [0.72, 1, 1],
            Extrapolation.CLAMP,
        ),
        transform: [{
            scaleX: interpolate(
                focusPresentation.value,
                [0, 1],
                [0.96, 1],
                Extrapolation.CLAMP,
            ),
        }],
    }), [focusedComposerHeight]);
    const focusedInputRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.22, 0.6],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 8 * (1 - reveal) }],
        };
    });
    const focusedActionsRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.46, 0.82],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 7 * (1 - reveal) }],
        };
    });

    React.useEffect(() => {
        if (!focusModeVisible) return;
        const timeout = setTimeout(() => focusedInputRef.current?.focus(), 50);
        return () => clearTimeout(timeout);
    }, [focusModeVisible]);

    React.useEffect(() => () => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
        }
    }, []);

    const openFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
        }
        focusPresentation.value = 0;
        setIsFocused(true);
        setFocusModeVisible(true);
        focusAnimationTimerRef.current = setTimeout(() => {
            focusPresentation.value = withTiming(1, {
                duration: 340,
                easing: Easing.out(Easing.cubic),
            });
            focusAnimationTimerRef.current = null;
        }, 16);
    }, [focusPresentation]);

    const finishCloseFocusMode = React.useCallback(() => {
        setIsFocused(false);
        setFocusModeVisible(false);
    }, []);

    const closeFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
            focusAnimationTimerRef.current = null;
        }
        focusedInputRef.current?.blur();
        inputRef.current?.blur();
        Keyboard.dismiss();
        focusPresentation.value = withTiming(0, {
            duration: 180,
            easing: Easing.in(Easing.cubic),
        }, (finished) => {
            if (finished) {
                runOnJS(finishCloseFocusMode)();
            }
        });
    }, [finishCloseFocusMode, focusPresentation]);

    const selectAgent = React.useCallback((agent: NewSessionAgentType) => {
        setAgentType(agent);
    }, [setAgentType]);

    React.useEffect(() => {
        const next = agentTypeIfHostDisallows(agentType, hostAgentKinds, hostAgentKindsAuthoritative, availableAgents);
        if (next !== null) selectAgent(next);
    }, [agentType, availableAgents, hostAgentKinds, hostAgentKindsAuthoritative, selectAgent]);

    type SettingsRow = {
        page: string;
        label: string;
        value: string;
        icon: React.ComponentProps<typeof Ionicons>['name'];
    };

    const environmentRows: SettingsRow[] = [
        { page: 'agent', label: 'AGENT', value: currentAgent.name, icon: 'hardware-chip-outline' },
        { page: 'machine', label: 'MACHINE', value: currentMachine?.name ?? 'Select machine', icon: 'desktop-outline' },
        { page: 'project', label: 'PROJECT', value: currentProject?.name ?? '~', icon: 'folder-outline' },
        { page: 'worktree', label: 'WORKTREE', value: currentWorktree?.name ?? 'No worktree', icon: 'git-branch-outline' },
    ];

    const gearSettingsGroups: NativeSettingsMenuGroup[] = [{
        key: 'agent',
        label: currentAgent.name || 'Agent',
        systemImage: 'cpu',
        options: availableAgents.map((option) => ({ key: option.key, label: option.name })),
        selectedKey: agentType,
        onSelect: (key) => selectAgent(key as NewSessionAgentType),
    }];

    const renderEnvironmentPickers = () => environmentRows.map((row, index) => (
        <FocusConfigRevealRow
            key={row.page}
            progress={focusPresentation}
            index={index}
        >
            <BubblePressable
                onPress={() => setOpenSheet(row.page as EnvironmentSetting)}
                style={styles.focusConfigRow}
                accessibilityRole="button"
                accessibilityLabel={row.label}
            >
                <View style={styles.focusConfigIcon}>
                    <Ionicons name={row.icon} size={21} color={theme.colors.text} />
                </View>
                <Text style={styles.focusConfigValue} numberOfLines={1}>{row.value}</Text>
                <View style={styles.focusConfigChevron}>
                    <Ionicons name="chevron-up" size={12} color={theme.colors.text} />
                    <Ionicons name="chevron-down" size={12} color={theme.colors.text} />
                </View>
            </BubblePressable>
        </FocusConfigRevealRow>
    ));

    const renderComposer = ({
        ref,
        onFocus,
        onBlur,
        onSend,
        activateOnPress,
    }: {
        ref: React.RefObject<TextInput | null>;
        onFocus: () => void;
        onBlur: () => void;
        onSend: () => void;
        activateOnPress?: () => void;
    }) => (
        <MobileGlassSurface
            nativeEffect
            intensity={78}
            glassEffectStyle="regular"
            style={styles.composerSurface}
        >
            <View style={styles.composerContent}>
                <PluginSlot slot="home.composer.leading" context={{}} />
                {activateOnPress ? (
                    <Pressable onPress={activateOnPress} style={styles.inputEntry}>
                        <Text
                            style={[styles.inputEntryText, !prompt && styles.inputEntryPlaceholder]}
                            numberOfLines={1}
                        >
                            {prompt || t('homeDock.inputPlaceholder')}
                        </Text>
                    </Pressable>
                ) : (
                    <TextInput
                        ref={ref}
                        value={prompt}
                        onChangeText={onPromptChange}
                        onSubmitEditing={() => canSubmit && onSend()}
                        onFocus={onFocus}
                        onBlur={onBlur}
                        placeholder={t('homeDock.inputPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        selectionColor={theme.colors.text}
                        returnKeyType="send"
                        autoCorrect
                        style={styles.input}
                    />
                )}
                <PluginSlot slot="home.composer.trailing" context={composerDraft} />
                <BubblePressable
                    onPress={onSend}
                    disabled={!canSubmit}
                    style={[styles.sendButton, canSubmit && styles.sendButtonActive]}
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                >
                    {isSubmitting ? (
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    ) : (
                        <Ionicons
                            name="arrow-up"
                            size={16}
                            color={canSubmit ? theme.colors.fab.icon : theme.colors.textSecondary}
                        />
                    )}
                </BubblePressable>
            </View>
        </MobileGlassSurface>
    );

    const submit = async () => {
        if (!canSubmit) return false;
        useNewSessionDraft.getState().setAttachments(selectedImages);
        const started = await onSubmit();
        if (started) clearImages();
        return started;
    };

    const submitFromFocusMode = () => {
        if (!canSubmit) return;
        setFocusModeVisible(false);
        setIsFocused(false);
        void submit();
    };

    const renderFocusedComposer = () => (
        <Animated.View style={[styles.focusedComposerAnimationShell, focusedComposerAnimationStyle]}>
            <MobileGlassSurface
                nativeEffect
                intensity={78}
                glassEffectStyle="regular"
                style={[
                    styles.focusedComposerSurface,
                    styles.focusedComposerAnchored,
                    selectedImages.length > 0 && styles.focusedComposerSurfaceWithAttachments,
                ]}
            >
                <View style={styles.focusedComposerContent}>
                    <Animated.View style={[styles.focusedInputReveal, focusedInputRevealStyle]}>
                        <AgentInputAttachmentStrip images={selectedImages} onRemove={removeImage} />
                        <TextInput
                            ref={focusedInputRef}
                            value={prompt}
                            onChangeText={onPromptChange}
                            onFocus={() => setIsFocused(true)}
                            placeholder={currentAgent.key === 'shell' ? t('homeDock.runCommandPlaceholder') : t('homeDock.askPlaceholder', { name: currentAgent.name })}
                            placeholderTextColor={theme.colors.textSecondary}
                            selectionColor={theme.colors.text}
                            autoCorrect
                            multiline
                            style={styles.focusedInput}
                        />
                    </Animated.View>
                    <Animated.View style={[styles.focusedComposerActions, focusedActionsRevealStyle]}>
                        <BubblePressable
                            onPress={() => void pickImages()}
                            style={styles.sideButton}
                            accessibilityRole="button"
                            accessibilityLabel="Add image"
                        >
                            <Ionicons name="add" size={26} color={theme.colors.text} />
                        </BubblePressable>
                        <NativeSettingsMenu groups={gearSettingsGroups} style={styles.nativeGearMenu}>
                            <View style={styles.sideButton}>
                                <Ionicons name="settings-outline" size={20} color={theme.colors.text} />
                            </View>
                        </NativeSettingsMenu>
                        <View style={styles.nativeModeMenu}>
                            <View style={styles.focusedModeButton}>
                                <Ionicons name="flash" size={18} color={theme.colors.text} />
                                <Text style={styles.focusedModeText} numberOfLines={1}>
                                    {currentAgent.name}
                                </Text>
                            </View>
                        </View>
                        <PluginSlot slot="home.composer.trailing" context={composerDraft} />
                        <BubblePressable
                            onPress={submitFromFocusMode}
                            disabled={!canSubmit}
                            style={[styles.sendButton, styles.focusedSendButton, canSubmit && styles.sendButtonActive]}
                            accessibilityRole="button"
                            accessibilityLabel="Send"
                        >
                        {isSubmitting ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        ) : (
                            <Ionicons
                                name="arrow-up"
                                size={16}
                                color={canSubmit ? theme.colors.fab.icon : theme.colors.textSecondary}
                            />
                        )}
                        </BubblePressable>
                    </Animated.View>
                </View>
            </MobileGlassSurface>
        </Animated.View>
    );

    return (
        <>
            <Animated.View
                pointerEvents="box-none"
                style={[styles.keyboardFollower, keyboardStyle]}
            >
                <View
                    pointerEvents="box-none"
                    style={[
                        styles.safeArea,
                        { paddingBottom: isFocused ? 8 : Math.max(10, safeArea.bottom) },
                    ]}
                >
                    {renderComposer({
                        ref: inputRef,
                        onFocus: openFocusMode,
                        onBlur: () => {
                            if (!focusModeVisible) setIsFocused(false);
                        },
                        onSend: submit,
                        activateOnPress: openFocusMode,
                    })}
                </View>
            </Animated.View>

            <RNModal
                visible={focusModeVisible}
                transparent
                animationType="none"
                onRequestClose={closeFocusMode}
            >
                <View style={styles.modalRoot}>
                    <Animated.View
                        pointerEvents="box-none"
                        style={[styles.modalBackdrop, styles.focusBackdrop, focusBackdropStyle]}
                    >
                        <Pressable
                            style={styles.modalBackdrop}
                            onPress={closeFocusMode}
                        />
                    </Animated.View>
                    <Animated.View style={[
                        styles.focusBackPosition,
                        { top: safeArea.top + 14 },
                        focusBackButtonStyle,
                    ]}>
                        <MobileGlassSurface
                            nativeEffect
                            interactive
                            intensity={80}
                            glassEffectStyle="regular"
                            style={styles.focusBackSurface}
                        >
                            <BubblePressable
                                onPress={closeFocusMode}
                                style={styles.focusBackButton}
                                pressedStyle={styles.sideButtonPressed}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.back')}
                            >
                                <Ionicons name="chevron-back" size={27} color={theme.colors.text} />
                            </BubblePressable>
                        </MobileGlassSurface>
                    </Animated.View>

                    <Animated.View style={[styles.focusDock, keyboardStyle]}>
                        <View style={styles.focusConfig}>
                            <View style={styles.focusConfigGroup}>
                                {renderEnvironmentPickers()}
                            </View>
                        </View>
                        <View style={[
                            styles.focusComposerArea,
                            { paddingBottom: safeArea.bottom + 8 },
                        ]}>
                            {renderFocusedComposer()}
                        </View>
                    </Animated.View>

                    <OptionSheet
                        visible={openSheet === 'agent'}
                        title="Agent"
                        options={availableAgents}
                        selectedKey={agentType}
                        onSelect={(agent) => selectAgent(agent.key as NewSessionAgentType)}
                        onClose={() => setOpenSheet(null)}
                        searchPlaceholder="search agents"
                    />
                    <OptionSheet
                        visible={openSheet === 'machine'}
                        title="Machine"
                        options={machineOptions}
                        selectedKey={selectedMachineId}
                        onSelect={(machine) => setMachineId(machine.key)}
                        onClose={() => setOpenSheet(null)}
                    />
                    <OptionSheet
                        visible={openSheet === 'project'}
                        title="Project"
                        options={projectOptions}
                        selectedKey={currentProject?.key}
                        onSelect={(project) => setPath(project.key)}
                        onClose={() => setOpenSheet(null)}
                        onSubmitCustom={(path) => setPath(path)}
                        searchPlaceholder="search or type a path"
                    />
                    <OptionSheet
                        visible={openSheet === 'worktree'}
                        title="Worktree"
                        options={worktreeOptions}
                        selectedKey={worktreeSelectionKey}
                        onSelect={(worktree) => {
                            const next = applyWorktreeSelection(worktree.key);
                            setSessionType(next.sessionType);
                            setWorktreeKey(next.worktreeKey);
                        }}
                        onClose={() => setOpenSheet(null)}
                    />
                </View>
            </RNModal>

        </>
    );
});
