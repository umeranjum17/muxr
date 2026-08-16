import * as React from 'react';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

// Rendered from wordmark.png (300x36): keep in sync with scripts/genBrand.sh.
const RATIO = 300 / 36;

export const Wordmark = React.memo(({ width = 260 }: { width?: number }) => {
    const { theme } = useUnistyles();
    return (
        <Image
            source={require('@/assets/images/wordmark.png')}
            contentFit="contain"
            tintColor={theme.colors.text}
            style={{ width, height: width / RATIO }}
        />
    );
});
