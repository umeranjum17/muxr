/**
 * The terminal's colours as a person tunes them in Settings. A device keeps
 * only the slots it changed; every other slot stays the renderer's own
 * default, so an untouched terminal draws exactly what it always drew.
 */

export const TERMINAL_ANSI_NAMES = [
    'Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
    'Bright black', 'Bright red', 'Bright green', 'Bright yellow', 'Bright blue', 'Bright magenta', 'Bright cyan', 'Bright white',
] as const;

export const TERMINAL_BASE_SLOTS = ['background', 'foreground', 'cursor', 'selection'] as const;
export type TerminalAnsiSlot = `ansi${number}`;
export type TerminalColorSlot = typeof TERMINAL_BASE_SLOTS[number] | TerminalAnsiSlot;
export const TERMINAL_ANSI_SLOTS = TERMINAL_ANSI_NAMES.map((_, index) => `ansi${index}` as TerminalAnsiSlot);
export const TERMINAL_COLOR_SLOTS: readonly TerminalColorSlot[] = [...TERMINAL_BASE_SLOTS, ...TERMINAL_ANSI_SLOTS];

/** Slot -> `#rrggbb`, only for the slots this device changed. */
export type TerminalColorOverrides = Partial<Record<TerminalColorSlot, string>>;

/** Every slot resolved to what the terminal draws. */
export type TerminalColors = Record<TerminalColorSlot, string>;

const BASE_NAMES: Record<typeof TERMINAL_BASE_SLOTS[number], string> = {
    background: 'Background',
    foreground: 'Text',
    cursor: 'Cursor',
    selection: 'Selection',
};

export function terminalColorName(slot: TerminalColorSlot): string {
    if (slot in BASE_NAMES) return BASE_NAMES[slot as keyof typeof BASE_NAMES];
    return TERMINAL_ANSI_NAMES[Number(slot.slice(4))] ?? slot;
}

/** `#abc`, `abc`, `#aabbcc` or `aabbcc` as lowercase `#aabbcc`; anything else is null. */
export function normalizeHex(value: string): string | null {
    const hex = value.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
    if (/^[0-9a-f]{3}$/.test(hex)) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    return null;
}

/**
 * Stored overrides, read defensively: an unknown slot or a malformed colour is
 * dropped rather than reaching the renderer.
 */
export function cleanTerminalColorOverrides(stored: unknown): TerminalColorOverrides {
    if (stored === null || typeof stored !== 'object') return {};
    const clean: TerminalColorOverrides = {};
    for (const slot of TERMINAL_COLOR_SLOTS) {
        const raw = (stored as Record<string, unknown>)[slot];
        const hex = typeof raw === 'string' ? normalizeHex(raw) : null;
        if (hex !== null) clean[slot] = hex;
    }
    return clean;
}

export function resolveTerminalColors(defaults: TerminalColors, overrides: TerminalColorOverrides): TerminalColors {
    return { ...defaults, ...overrides } as TerminalColors;
}

function channels(hex: string): [number, number, number] {
    const value = Number.parseInt((normalizeHex(hex) ?? '#000000').slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG 2 contrast ratio between two colours, 1 (none) to 21. */
export function contrastRatio(a: string, b: string): number {
    const luminance = (hex: string) => {
        const [r, g, b] = channels(hex).map((channel) => {
            const c = channel / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light! + 0.05) / (dark! + 0.05);
}

/** Below WCAG AA for body text, which is what a terminal is. */
export const READABLE_CONTRAST = 4.5;

export type Hsv = { h: number; s: number; v: number };

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export function hexToHsv(hex: string): Hsv {
    const [r, g, b] = channels(hex).map((channel) => channel / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let h = 0;
    if (delta > 0) {
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
    }
    return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
    const f = (n: number) => {
        const k = (n + h / 60) % 6;
        return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    };
    return `#${[f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** A renderer's palette as slots: the base colours plus its 16 ANSI entries. */
export function terminalColorsFrom(palette: { background: string; foreground: string; cursor: string; selection: string; ansi: readonly string[] }): TerminalColors {
    const colors = { background: palette.background, foreground: palette.foreground, cursor: palette.cursor, selection: palette.selection } as TerminalColors;
    TERMINAL_ANSI_SLOTS.forEach((slot, index) => { colors[slot] = palette.ansi[index]!; });
    return colors;
}
