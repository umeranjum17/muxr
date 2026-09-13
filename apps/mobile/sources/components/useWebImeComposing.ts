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
 *
 * `active` must track composer availability (mounted and controllable), not
 * a constant: the effect attaches when the node appears and detaches when
 * it goes away, so hosted authority resolving after mount still gets the
 * guard and observe/control transitions re-attach to the fresh node.
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
            // Losing the composer (observe, unmount, remount) must neither
            // leave listeners on a dead node nor strand a stale composing
            // flag that would block every later submit.
            isComposingRef.current = false;
            node.removeEventListener?.('compositionstart', onStart);
            node.removeEventListener?.('compositionend', onEnd);
        };
    }, [inputRef, active]);
    return isComposingRef;
}
