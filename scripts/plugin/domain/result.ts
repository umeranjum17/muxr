export type Accepted<T> = { ok: true; value: T };
export type Rejected = { ok: false; reason: string };
export type Result<T> = Accepted<T> | Rejected;

export function accepted<T>(value: T): Accepted<T> {
    return { ok: true, value };
}

export function rejected(reason: string): Rejected {
    return { ok: false, reason };
}
