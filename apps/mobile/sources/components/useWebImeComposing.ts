import * as React from 'react';
import { Platform, type TextInput } from 'react-native';

type DomNode = {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
} | null;

/**
 * Tracks IME composition on a web TextInput. Enter confirms composition in
 * CJK input methods; submitting on that keystroke would send half-composed
 * text, so guarded onSubmitEditing handlers check
 * `isComposingRef.current` first. Native needs nothing: the OS delivers
 * composed text. Returns a ref that stays false everywhere off web.
 */
export function useWebImeComposing(
    inputRef: React.RefObject<TextInput | null>,
    active: boolean,
): React.RefObject<boolean> {
    const isComposingRef = React.useRef(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !active) return;
        const node = inputRef.current as unknown as DomNode;
        if (node?.addEventListener === undefined || node.removeEventListener === undefined) return;
        const onStart = () => { isComposingRef.current = true; };
        const onEnd = () => { isComposingRef.current = false; };
        node.addEventListener('compositionstart', onStart);
        node.addEventListener('compositionend', onEnd);
        return () => {
            node.removeEventListener?.('compositionstart', onStart);
            node.removeEventListener?.('compositionend', onEnd);
        };
    }, [inputRef, active]);
    return isComposingRef;
}
