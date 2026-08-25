export interface GeneratedAvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}

/** Stable seed shared by every generated avatar renderer. */
export function avatarHash(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(index);
        hash &= hash;
    }
    return Math.abs(hash);
}
