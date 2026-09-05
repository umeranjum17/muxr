/** Quote one value for the POSIX shell used by the connected host. */
export function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
