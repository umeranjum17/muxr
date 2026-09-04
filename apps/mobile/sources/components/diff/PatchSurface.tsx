import * as React from 'react';
import { View } from 'react-native';
import { CodeSurface } from '@/components/document/CodeSurface';
import { surfaceModel } from '@/components/document/surfaceModel';
import { useMonoCharWidth } from '@/components/code/monoMetrics';
import type { CodeContentPadding } from '@/components/code/CodeCore';

/** Tall enough to be a reading surface inside a plugin screen, not a preview. */
const MIN_HEIGHT = 480;

/**
 * A patch with no file content behind it, on the same reading surface the
 * document viewer uses. A diff a plugin shows and a diff the viewer shows are
 * the same thing to a reader, so they get the same column, pills and scrubber.
 */
export function PatchSurface(props: {
    patch: string;
    contentWidth?: number;
    fontSize?: number;
    contentPadding?: CodeContentPadding;
    onHunkIndices?: (indices: number[]) => void;
}) {
    // A plugin card hands us no width, so measure the slot we land in.
    const [measured, setMeasured] = React.useState(0);
    const size = props.fontSize ?? 11;
    const { charWidth, probe } = useMonoCharWidth([size, size - 1]);
    const built = React.useMemo(() => surfaceModel({ diff: props.patch, showChanges: true }), [props.patch]);
    const onHunkIndices = props.onHunkIndices;
    React.useEffect(() => { onHunkIndices?.(built?.hunkRows ?? []); }, [built, onHunkIndices]);
    const padding = props.contentPadding ?? { horizontal: 8, top: 8, bottom: 48 };
    const width = props.contentWidth ?? measured;
    if (built === null) return null;
    return (
        <View
            style={{ flex: 1, minHeight: MIN_HEIGHT }}
            onLayout={(event) => setMeasured(event.nativeEvent.layout.width - padding.horizontal * 2)}
        >
            {width > 0 && (
                <CodeSurface
                    rows={built.rows}
                    hunkRows={built.hunkRows}
                    foldUnchanged={built.foldUnchanged}
                    separators={built.separators}
                    contentWidth={width}
                    charWidth={charWidth(size)}
                    fontSize={size}
                    isNarrow
                    paddingTop={padding.top}
                    paddingBottom={padding.bottom}
                />
            )}
            {probe}
        </View>
    );
}
