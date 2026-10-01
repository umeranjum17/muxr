import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    StyleSheet,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { AnimatedBlurBackdrop } from '@/components/AnimatedOverlay';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
    animationType?: 'fade' | 'slide' | 'none';
    transparent?: boolean;
    closeOnBackdrop?: boolean;
    /** 'bottom' turns the modal into a full-width sheet that rises from the edge. */
    align?: 'center' | 'bottom';
}

export function BaseModal({
    visible,
    onClose,
    children,
    animationType = 'fade',
    transparent = true,
    closeOnBackdrop = true,
    align = 'center'
}: BaseModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [webViewport, setWebViewport] = useState<{ top: number; height: number }>();

    useEffect(() => {
        if (Platform.OS !== 'web' || !visible) return;
        const viewport = window.visualViewport;
        if (!viewport) return;
        // Web modals live outside the app root. Safari leaves their layout
        // viewport tall when the keyboard covers the bottom of the screen.
        const update = () => setWebViewport(viewport.scale === 1
            ? { top: viewport.offsetTop, height: viewport.height }
            : undefined);
        update();
        viewport.addEventListener('resize', update);
        viewport.addEventListener('scroll', update);
        return () => {
            viewport.removeEventListener('resize', update);
            viewport.removeEventListener('scroll', update);
        };
    }, [visible]);

    useEffect(() => {
        if (visible) {
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver: true
            }).start();
        } else {
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 200,
                useNativeDriver: true
            }).start();
        }
    }, [visible, fadeAnim]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    return (
        <Modal
            visible={visible}
            transparent={transparent}
            animationType={animationType}
            onRequestClose={onClose}
        >
            <KeyboardAvoidingView
                style={[
                    styles.container,
                    align === 'bottom' && styles.containerBottom,
                    webViewport && { position: 'absolute', left: 0, right: 0, ...webViewport },
                ]}
                enabled={Platform.OS !== 'web'}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                {...webEventHandlers}
            >
                {Platform.OS === 'web' ? (
                    <TouchableWithoutFeedback onPress={handleBackdropPress}>
                        <Animated.View
                            style={[
                                styles.backdrop,
                                {
                                    opacity: fadeAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0, 0.5],
                                    }),
                                },
                            ]}
                        />
                    </TouchableWithoutFeedback>
                ) : (
                    <AnimatedBlurBackdrop
                        blurIntensity={44}
                        dimColor="rgba(0, 0, 0, 0.42)"
                        onPress={handleBackdropPress}
                    />
                )}
                
                <Animated.View
                    style={[
                        styles.content,
                        align === 'bottom' && styles.contentBottom,
                        {
                            opacity: fadeAnim,
                            transform: [align === 'bottom' ? {
                                translateY: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [320, 0]
                                })
                            } : {
                                scale: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0.9, 1]
                                })
                            }]
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
        justifyContent: 'center',
        alignItems: 'center',
        // On web, ensure modal can receive pointer events when body has pointer-events: none
        ...Platform.select({ web: { pointerEvents: 'auto' as const } })
    },
    containerBottom: {
        justifyContent: 'flex-end',
        alignItems: 'stretch'
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'black',
    },
    content: {
        zIndex: 1
    },
    contentBottom: {
        width: '100%'
    }
});
