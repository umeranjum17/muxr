export function scratchBase(): string;
export function processStart(pid: number): string | undefined;
export function processGroup(pid: number): number | undefined;
export function testScratchOwner(base: string): void;
export function cleanTestScratch(root: string): void;
export function scratchEntries(root: string): string[];
export function scratchUnused(root: string, finishing?: boolean): boolean;
