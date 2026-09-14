export interface Command {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    shortcut?: string;
    category?: string;
    action: () => void | Promise<void>;
    secondaryAction?: () => void | Promise<void>;
    secondaryLabel?: string;
    actionLabel?: string;
}

export interface CommandCategory {
    id: string;
    title: string;
    commands: Command[];
}
