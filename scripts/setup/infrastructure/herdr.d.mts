export function herdrBin(): string | undefined;
export function findHerdrBin(onError?: (error: unknown) => void): string | undefined;
export function herdrAvailability(configured?: string): 'missing' | 'outdated' | undefined;
export const HERDR_OUTDATED: string;
