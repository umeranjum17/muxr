import React, { useEffect, useRef } from 'react';
import {
    Modal,
    TouchableWithoutFeedback,
    Animated,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

interface CommandPaletteModalProps {
    visible: boolean;
    onClose?: () => void;
    /** Terminal appearance on a phone renders as a bottom sheet, not a centred card. */
    appearance?: 'terminal';
    children: React.ReactNode;
}

export function CommandPaletteModal({
    visible,
    onClose,
    appearance,
    children
}: CommandPaletteModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim = useRef(new Animated.Value(0.95)).current;
    const [isModalVisible, setIsModalVisible] = React.useState(true);
    const { width, height } = useWindowDimensions();
    const sheet = appearance === 'terminal' && width < 500;
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();

    useEffect(() => {
        if (visible) {
            // Opening animation
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: true
                }),
                Animated.spring(scaleAnim, {
                    toValue: 1,
                    friction: 10,
                    tension: 60,
                    useNativeDriver: true
                })
            ]).start();
        }
    }, [visible, fadeAnim, scaleAnim]);

    const handleClose = React.useCallback(() => {
        // Closing animation
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 150,
                useNativeDriver: true
            }),
            Animated.timing(scaleAnim, {
                toValue: 0.95,
                duration: 150,
                useNativeDriver: true
            })
        ]).start(() => {
            setIsModalVisible(false);
            // Small delay to ensure modal is hidden before calling onClose
            setTimeout(() => {
                if (onClose) {
                    onClose();
                }
            }, 50);
        });
    }, [fadeAnim, scaleAnim, onClose]);

    const handleBackdropPress = () => {
        handleClose();
    };

    if (!isModalVisible) {
        return null;
    }

    return (
        <Modal
            visible={isModalVisible}
            transparent={true}
            animationType="none"
            onRequestClose={handleClose}
            statusBarTranslucent={Platform.OS === 'android'}
        >
            <KeyboardAvoidingView
                style={[styles.container, sheet && styles.containerSheet, {
                    paddingTop: sheet ? 0 : Platform.OS === 'web' ? Math.min(140, height * 0.12) : insets.top + 12,
                    paddingBottom: sheet ? insets.bottom : Platform.OS === 'web' ? 12 : Math.max(insets.bottom, 12),
                }]}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <TouchableWithoutFeedback onPress={handleBackdropPress}>
                    <Animated.View
                        style={[
                            styles.backdrop,
                            { backgroundColor: theme.colors.scrim },
                            {
                                opacity: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1]
                                })
                            }
                        ]}
                    />
                </TouchableWithoutFeedback>

                <Animated.View
                    style={[
                        styles.content,
                        sheet && styles.contentSheet,
                        {
                            opacity: fadeAnim,
                            transform: [{ scale: scaleAnim }]
                        }
                    ]}
                >
                    {children}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'center',
        minHeight: 0,
    },
    containerSheet: {
        justifyContent: 'flex-end',
        alignItems: 'stretch',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
    },
    content: {
        zIndex: 1,
        width: '90%',
        maxWidth: 800,
        flexShrink: 1,
    },
    contentSheet: {
        width: '100%',
        maxWidth: '100%',
    },
});
