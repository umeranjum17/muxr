/**
 * Reads the receiver statistics `@desklink/react-native`'s `getStats()` returns
 * into the few fields that prove which decoder the platform is running: the
 * decoder implementation, frames per second, codec and picture size.
 *
 * Nothing here synthesises a value. A field the kit did not report reads as
 * "unknown", and a video record that was never returned reads as "absent", so
 * the screen shows exactly what the receiver measured.
 */

/** One record from `getStats()`; every field is optional and untyped. */
export type DesktopStatRecord = Record<string, unknown>;

/** A labelled value the debug screen can render verbatim. */
export interface DecoderReading {
    decoder: string;
    fps: string;
    codec: string;
    resolution: string;
    framesDecoded: string;
    framesDropped: string;
    packetsLost: string;
}

/** Shown when the kit returned the record but not this field. */
export const UNKNOWN_FIELD = 'unknown';
/** Shown when the kit returned no video record at all. */
export const ABSENT_STAT = 'absent';

function isVideoInbound(record: DesktopStatRecord): boolean {
    return record.type === 'inbound-rtp' && (record.kind === 'video' || record.mediaType === 'video');
}

function asText(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim() === '' ? undefined : value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function field(record: DesktopStatRecord | undefined, key: string): string {
    if (record === undefined) return ABSENT_STAT;
    return asText(record[key]) ?? UNKNOWN_FIELD;
}

function resolution(record: DesktopStatRecord | undefined): string {
    if (record === undefined) return ABSENT_STAT;
    const width = asText(record.frameWidth);
    const height = asText(record.frameHeight);
    if (width === undefined || height === undefined) return UNKNOWN_FIELD;
    return `${width}×${height}`;
}

/**
 * The codec whose media is video, matched to the inbound stream by `codecId`
 * where the receiver reports one.
 */
function videoCodec(report: DesktopStatRecord[], inbound: DesktopStatRecord | undefined): DesktopStatRecord | undefined {
    const codecs = report.filter((record) => record.type === 'codec' && typeof record.mimeType === 'string' && record.mimeType.startsWith('video/'));
    if (inbound !== undefined && inbound.codecId !== undefined) {
        const match = codecs.find((record) => record.id === inbound.codecId);
        if (match !== undefined) return match;
    }
    return codecs[0];
}

/** Reads the rows the debug screen shows from one `getStats()` snapshot. */
export function readDecoderStats(report: DesktopStatRecord[] | undefined): DecoderReading {
    const inbound = report?.find(isVideoInbound);
    const codec = report === undefined ? undefined : videoCodec(report, inbound);
    return {
        decoder: field(inbound, 'decoderImplementation'),
        fps: field(inbound, 'framesPerSecond'),
        codec: field(codec, 'mimeType'),
        resolution: resolution(inbound),
        framesDecoded: field(inbound, 'framesDecoded'),
        framesDropped: field(inbound, 'framesDropped'),
        packetsLost: field(inbound, 'packetsLost'),
    };
}
