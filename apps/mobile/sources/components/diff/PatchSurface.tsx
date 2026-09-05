import * as React from 'react';
import { View } from 'react-native';
import { CodeSurface } from '@/components/document/CodeSurface';
import { surfaceModel } from '@/components/document/surfaceModel';
import { useMonoCharWidth } from '@/components/code/monoMetrics';
import type { CodeContentPadding } from '@/components/code/CodeCore';
import { patchFiles } from '@/components/diff/patchFiles';
import { syntaxLanguage } from '@/components/code/syntaxHighlighting';
import { PanelHeader } from '@/components/document/PanelHeader';

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
    const size = props.fontSize ?? 12;
    const { charWidth, probe } = useMonoCharWidth([size, size - 1]);
    const built = React.useMemo(() => surfaceModel({ diff: props.patch, showChanges: true }), [props.patch]);
    // A patch names its own file, so a plugin's diff gets the same syntax
    // colours and the same header the document viewer gives this content.
    const file = React.useMemo(() => {
        const files = patchFiles(props.patch);
        return files.length === 1 ? files[0] : undefined;
    }, [props.patch]);
    const language = syntaxLanguage(undefined, file?.label);
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
                    wrap={false}
                    paddingTop={padding.top}
                    {...(language === undefined ? {} : { language })}
                    {...(file === undefined ? {} : {
                        header: <PanelHeader
                            path={file.label}
                            {...(language === undefined ? {} : { language })}
                            added={file.added}
                            removed={file.removed}
                        />,
                    })}
                    paddingBottom={padding.bottom}
                />
            )}
            {probe}
        </View>
    );
}
