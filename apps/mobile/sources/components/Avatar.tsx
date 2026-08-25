import * as React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { AvatarSkia } from "./AvatarSkia";
import { AvatarGradient } from "./AvatarGradient";
import { AvatarBrutalist } from "./AvatarBrutalist";
import { useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GeneratedAvatarProps } from './generatedAvatar';

interface AvatarProps extends GeneratedAvatarProps {
    flavor?: string | null;
    clientId?: string | null;
    imageUrl?: string | null;
    thumbhash?: string | null;
}

// muxr runs a single agent, so the badge is always the pi mark, tinted at
// both use sites.
const piIcon = require('@/assets/images/icon-pi.png');

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    flavorIcon: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: theme.colors.surface,
        borderRadius: 100,
        padding: 2,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
        elevation: 3,
    },
}));

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, clientId, size = 48, imageUrl, thumbhash, ...avatarProps } = props;
    const avatarStyle = useSetting('avatarStyle');
    const showFlavorIcons = useSetting('showFlavorIcons');
    const { theme } = useUnistyles();

    // Render custom image if provided
    if (imageUrl) {
        const imageElement = (
            <Image
                source={{ uri: imageUrl, thumbhash: thumbhash || undefined }}
                placeholder={thumbhash ? { thumbhash: thumbhash } : undefined}
                contentFit="cover"
                style={{
                    width: size,
                    height: size,
                    borderRadius: avatarProps.square ? 0 : size / 2
                }}
            />
        );

        // Add flavor icon overlay if enabled
        if (showFlavorIcons && (flavor || clientId === 'rig')) {
            const circleSize = Math.round(size * 0.35);
            const iconSize = Math.round(size * 0.28);

            return (
                <View style={[styles.container, { width: size, height: size }]}>
                    {imageElement}
                    <View style={[styles.flavorIcon, {
                        width: circleSize,
                        height: circleSize,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }]}>
                        <Image
                            source={piIcon}
                            style={{ width: iconSize, height: iconSize }}
                            contentFit="contain"
                            tintColor={theme.colors.text}
                        />
                    </View>
                </View>
            );
        }

        return imageElement;
    }

    // Original generated avatar logic
    // Determine which avatar variant to render
    let AvatarComponent: React.ComponentType<GeneratedAvatarProps>;
    if (avatarStyle === 'pixelated') {
        AvatarComponent = AvatarSkia;
    } else if (avatarStyle === 'brutalist') {
        AvatarComponent = AvatarBrutalist;
    } else {
        AvatarComponent = AvatarGradient;
    }

    const circleSize = Math.round(size * 0.35);
    const iconSize = Math.round(size * 0.28);

    // Only wrap in container if showing flavor icons and flavor was provided
    if (showFlavorIcons && (flavor !== null || clientId === 'rig')) {
        return (
            <View style={[styles.container, { width: size, height: size }]}>
                <AvatarComponent {...avatarProps} size={size} />
                <View style={[styles.flavorIcon, {
                    width: circleSize,
                    height: circleSize,
                    alignItems: 'center',
                    justifyContent: 'center'
                }]}>
                    <Image
                        source={piIcon}
                        style={{ width: iconSize, height: iconSize }}
                        contentFit="contain"
                        tintColor={theme.colors.text}
                    />
                </View>
            </View>
        );
    }

    // Return avatar without wrapper when not showing flavor icons
    return <AvatarComponent {...avatarProps} size={size} />;
});
