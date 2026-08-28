import { NATIVE_SLOT_CONTEXT_KEYS, type PluginNativeSlot } from '@muxr/contract';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

export interface SessionMenuItem {
    label: string;
    /** One line saying what it actually does. Phones have no hover tooltip. */
    hint?: string;
    /** Reads in the destructive tone, the way an action sheet marks the one that ends something. */
    destructive?: boolean;
    onPress: () => void;
}

export interface SessionMenu {
    title: string;
    note?: string;
    items: SessionMenuItem[];
}

/** Live terminal handle: plugins only send keystrokes; they never own the pane. */
export type PluginTerminalChannel = {
    sendText: (text: string) => void;
};

export interface PluginSlotContexts {
    'app.overlay': {};
    'navigation.primary': { active: boolean; onSelect: () => void };
    'navigation.content': { pluginId?: string; contributionId?: string; params?: Record<string, string>; topContentInset?: number; bottomContentInset?: number; onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void };
    'home.cards': {};
    'home.composer.leading': {};
    'home.composer.trailing': { getText: () => string; setText: (text: string) => void };
    'session.header.trailing': { sessionId: string; cwd?: string };
    'session.overlay': {
        sessionId: string;
        visible: boolean;
        onClose: () => void;
        openMenu: (menu: SessionMenu) => void;
        showHint: (text: string) => void;
    };
    'session.pills': { sessionId: string };
    'session.composer.trailing': { sessionId: string; getText: () => string; setText: (text: string) => void };
    'terminal.key-row': { channel: PluginTerminalChannel | undefined };
    'settings.items': {};
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type ContextKeysMatch = {
    [S in PluginNativeSlot]: Equal<keyof PluginSlotContexts[S] & string, typeof NATIVE_SLOT_CONTEXT_KEYS[S][number]>
}[PluginNativeSlot] extends true ? true : false;

/** Compile-time tripwire: contract slot keys and actual React contexts cannot drift. */
const contextKeysMatch: ContextKeysMatch = true;
void contextKeysMatch;
