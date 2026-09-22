/**
 * The Shared Artifacts wire, and the one place that knows it was once called
 * `attachment`.
 *
 * The artifact unification renamed the four protocol methods and their params.
 * A host older than this build answers only the legacy names and shapes, so the
 * first `host-contract-mismatch` pins the legacy wire for the rest of the
 * process; reconnecting after a host update probes the canonical names again.
 *
 * Delete this module's legacy half, the contract's deprecated request entries
 * and the host's matching aliases once no pre-rename build can still be paired.
 */
import type { RequestParams, RequestResult, RequestType, SessionArtifactMetadata } from '@muxr/contract';

/** The transport this wire speaks through; `sync.request` in the app. */
export type ArtifactWireTransport = <T extends RequestType>(
    type: T,
    params: RequestParams<T>,
    timeoutMs?: number,
) => Promise<RequestResult<T>>;

export interface ArtifactListing {
    artifacts: SessionArtifactMetadata[];
    total: number;
    truncated: boolean;
}

export interface ArtifactChunk {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    offset: number;
    data: string;
}

export interface ArtifactTicket {
    token: string;
    name: string;
    mimeType: string;
    size: number;
}

export interface ArtifactWire {
    list(sessionId: string): Promise<ArtifactListing>;
    fetch(sessionId: string, artifactId: string): Promise<{ name: string; mimeType: string; data: string } | null>;
    prepare(sessionId: string, artifactId: string): Promise<ArtifactTicket | null>;
    read(sessionId: string, artifactId: string, offset: number, length: number, timeoutMs?: number): Promise<ArtifactChunk | null>;
}

function hostContractMismatch(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && String(error.code) === 'host-contract-mismatch';
}

export function createArtifactWire(request: ArtifactWireTransport): ArtifactWire {
    let legacy = false;

    async function canonicalOrLegacy<T>(canonical: () => Promise<T>, legacyCall: () => Promise<T>): Promise<T> {
        if (!legacy) {
            try {
                return await canonical();
            } catch (error) {
                if (!hostContractMismatch(error)) throw error;
                legacy = true;
            }
        }
        return legacyCall();
    }

    return {
        async list(sessionId) {
            return canonicalOrLegacy(
                async () => {
                    const listing = await request('artifact.list', { sessionId });
                    return { artifacts: listing.artifacts, total: listing.total, truncated: listing.truncated };
                },
                async () => {
                    const listing = await request('attachment.list', { sessionId });
                    return { artifacts: listing.attachments, total: listing.total, truncated: listing.truncated };
                },
            );
        },
        fetch(sessionId, artifactId) {
            return canonicalOrLegacy(
                () => request('artifact.fetch', { sessionId, artifactId }),
                () => request('attachment.fetch', { sessionId, attachmentId: artifactId }),
            );
        },
        prepare(sessionId, artifactId) {
            return canonicalOrLegacy(
                () => request('artifact.prepare', { sessionId, artifactId }),
                () => request('attachment.prepare', { sessionId, attachmentId: artifactId }),
            );
        },
        read(sessionId, artifactId, offset, length, timeoutMs) {
            return canonicalOrLegacy(
                () => request('artifact.read', { sessionId, artifactId, offset, length }, timeoutMs),
                () => request('attachment.read', { sessionId, attachmentId: artifactId, offset, length }, timeoutMs),
            );
        },
    };
}
