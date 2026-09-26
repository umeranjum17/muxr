import type { TextInputProps } from 'react-native';

/**
 * The composer's keyboard behaviour per pane kind. A shell must receive
 * commands exactly as typed, so its keyboard gets no capitalising, no
 * autocorrect, no spellcheck and no smart punctuation; an agent pane keeps
 * the keyboard's prose helpers, because people type sentences to agents.
 *
 * RN 0.83 exposes no smartQuotes/smartDashes props any more, so the
 * surviving smart-punctuation prop, smartInsertDelete, is the closest the
 * input's props get; it is set too.
 */
export function composerKeyboardProps(isShell: boolean): Pick<TextInputProps, 'autoCapitalize' | 'autoCorrect' | 'spellCheck' | 'smartInsertDelete'> {
    return isShell
        ? { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, smartInsertDelete: false }
        : {};
}
