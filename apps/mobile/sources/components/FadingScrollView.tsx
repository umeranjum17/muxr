import * as React from 'react';
import { ScrollView, ScrollViewProps, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { withAlpha } from '@/components/ui';

const FADE = 28;

/**
 * A vertical ScrollView that shows when it holds more than it shows: while
 * rows lie past its bottom edge that edge dissolves into `fadeInto`, and its
 * scroll indicator flashes the first time it can scroll. A list cut near a row
 * boundary otherwise reads as complete: at 270 dp the pane menu showed 1.5 dp
 * of Usage under Shared Artifacts, and a dozen more rows below it went unseen.
 */
export function FadingScrollView({ fadeInto, children, ...props }: ScrollViewProps & { fadeInto: string }) {
    const ref = React.useRef<ScrollView>(null);
    const size = React.useRef({ shown: 0, content: 0, offset: 0 });
    const [more, setMore] = React.useState(false);
    const flashed = React.useRef(false);
    const measure = () => {
        const { shown, content, offset } = size.current;
        setMore(shown > 0 && offset + shown < content - 1);
    };
    React.useEffect(() => {
        if (!more || flashed.current) return;
        flashed.current = true;
        ref.current?.flashScrollIndicators();
    }, [more]);
    return (
        <View style={{ flexShrink: 1 }}>
            <ScrollView
                ref={ref}
                scrollEventThrottle={32}
                {...props}
                onLayout={(event) => { size.current.shown = event.nativeEvent.layout.height; measure(); }}
                onContentSizeChange={(_, height) => { size.current.content = height; measure(); }}
                onScroll={(event) => { size.current.offset = event.nativeEvent.contentOffset.y; measure(); }}
            >
                {children}
            </ScrollView>
            {more && <LinearGradient
                pointerEvents="none"
                colors={[withAlpha(fadeInto, 0), fadeInto]}
                style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: FADE }}
            />}
        </View>
    );
}
