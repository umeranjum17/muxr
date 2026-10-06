/**
 * The name an account is given before anyone names it: from its own email
 * alone, and never the name another account already carries.
 *
 * The name a person ends up with is their own labelling of their own account,
 * so a suggestion that repeats or collides destroys something they chose. The
 * same addresses always give the same names.
 */

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
const MAX_NAME = 64;

function title(segment: string): string {
    return segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase();
}

/**
 * `taken` holds the names already in use. A name that collides takes the next
 * part of the same email ("umer.work@example.com" beside "Umer" gives
 * "Umer Work"), then a number. Never another account's email, never a name
 * from a previous add, never blank.
 */
export function accountNameFrom(email: string | undefined, provider: string, taken: readonly string[] = []): string {
    const held = new Set(taken.map((name) => name.trim().toLowerCase()));
    const free = (name: string): boolean => !held.has(name.trim().toLowerCase());
    const parts = (email?.split('@')[0] ?? '').split(/[._-]+/).filter(Boolean).map(title);
    const base = parts.shift() ?? PROVIDER_NAMES[provider] ?? provider;
    const names: string[] = [base];
    for (const part of parts) names.push(`${base} ${part}`);
    for (let n = 2; names.length < 64; n++) names.push(`${base} ${n}`);
    return (names.map((name) => name.slice(0, MAX_NAME)).find(free)) ?? base.slice(0, MAX_NAME);
}