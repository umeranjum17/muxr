export interface Command {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    shortcut?: string;
    category?: string;
    /** Mono argument hint drawn after the title, e.g. `[focus]` for `/compact`. */
    hint?: string;
    /** Draws the destructive dot and colour; the section and confirm carry the rest. */
    destructive?: boolean;
        action: () => void | false | Promise<void | false>;
    secondaryAction?: () => void | Promise<void>;
    secondaryLabel?: string;
    actionLabel?: string;
}

export interface CommandCategory {
    id: string;
    title: string;
    commands: Command[];
}

/** The one "type a command" row's category; the palette keeps it visible when a search matches nothing. */
export const CUSTOM_CATEGORY = 'Custom';
