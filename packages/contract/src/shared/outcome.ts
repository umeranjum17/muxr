/** Expected rejection at a parse/decision boundary. Bugs still throw. */
export type Outcome<T, E = string> =
    | { ok: true; value: T }
    | { ok: false; error: E };

export function ok<T>(value: T): Outcome<T, never> {
    return { ok: true, value };
}

export function fail<E>(error: E): Outcome<never, E> {
    return { ok: false, error };
}

export function unwrapOrThrow<T>(outcome: Outcome<T, string>): T {
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
}
