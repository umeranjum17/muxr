type ModePickerSource = {
    key: string;
    name: string;
    description?: string | null;
};

export type NewSessionPickerItem = {
    key: string;
    label: string;
    subtitle?: string;
};

export function getModePickerItems(options: ModePickerSource[]): NewSessionPickerItem[] {
    return options.map((option) => ({
        key: option.key,
        label: option.name,
        ...(option.description ? { subtitle: option.description } : {}),
    }));
}
