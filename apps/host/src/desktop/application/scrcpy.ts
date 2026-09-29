/**
 * The scrcpy v4.0 wire, as the host speaks it to a task-owned emulator.
 *
 * Field layouts follow Genymobile/scrcpy at tag v4.0
 * (`server/.../control/ControlMessageReader.java`,
 * `server/.../device/Streamer.java`), which is the exact server vendored in
 * `resources/scrcpy/`. The protocol is version-locked: the server refuses a
 * client version that is not its own, and the host passes `4.0`.
 */

/** Control message types the host sends (v4.0 `ControlMessage`). */
const INJECT_KEYCODE = 0;
const INJECT_TEXT = 1;
const INJECT_TOUCH_EVENT = 2;
const INJECT_SCROLL_EVENT = 3;
const BACK_OR_SCREEN_ON = 4;
const ROTATE_DEVICE = 11;
const RESET_VIDEO = 17;

/** Android key actions (`KeyEvent.ACTION_*`, a stable ABI). */
export const ANDROID_ACTION_DOWN = 0;
export const ANDROID_ACTION_UP = 1;

/** Android keycodes (`KeyEvent.KEYCODE_*`) the preview toolbar needs. */
export const ANDROID_KEYCODE_HOME = 3;
export const ANDROID_KEYCODE_APP_SWITCH = 187;

/** Android touch actions (`MotionEvent.ACTION_*`) for one finger. */
export const ANDROID_TOUCH_DOWN = 0;
export const ANDROID_TOUCH_UP = 1;
export const ANDROID_TOUCH_MOVE = 2;
export const ANDROID_TOUCH_CANCEL = 3;

/**
 * The finger a phone touch is: scrcpy's virtual finger, not a mouse
 * (`SC_POINTER_ID_VIRTUAL_FINGER`, i.e. uint64 -3).
 */
const VIRTUAL_FINGER = 0xfffffffffffffffDn;

/** One byte that asks the server to restart its encoder (new SPS + IDR). */
export const RESET_VIDEO_MESSAGE = Buffer.from([RESET_VIDEO]);
/** One byte that rotates the device (no payload, no angle). */
export const ROTATE_DEVICE_MESSAGE = Buffer.from([ROTATE_DEVICE]);

/** `INJECT_KEYCODE`: type + action + keycode + repeat + meta-state, big-endian. */
export function encodeInjectKeycode(action: number, keycode: number): Buffer {
    const out = Buffer.alloc(14);
    out.writeUInt8(INJECT_KEYCODE, 0);
    out.writeUInt8(action, 1);
    out.writeInt32BE(keycode, 2);
    out.writeInt32BE(0, 6);
    out.writeInt32BE(0, 10);
    return out;
}

/** `INJECT_TEXT`: type + byte length + UTF-8. */
export function encodeText(text: string): Buffer {
    const raw = Buffer.from(text, 'utf8');
    const out = Buffer.alloc(5 + raw.length);
    out.writeUInt8(INJECT_TEXT, 0);
    out.writeInt32BE(raw.length, 1);
    raw.copy(out, 5);
    return out;
}

function writePosition(out: Buffer, offset: number, x: number, y: number, width: number, height: number): void {
    out.writeInt32BE(x, offset);
    out.writeInt32BE(y, offset + 4);
    out.writeUInt16BE(width, offset + 8);
    out.writeUInt16BE(height, offset + 10);
}

/** Fixed-point pressure the way `Binary.u16FixedPointToFloat` reads it back. */
function pressureFixedPoint(pressure: number): number {
    if (pressure >= 1) return 0xffff;
    if (pressure <= 0) return 0;
    return Math.round(pressure * 65536);
}

/**
 * `INJECT_TOUCH_EVENT`: a phone finger is always the virtual finger at full
 * pressure (zero on release), with no mouse buttons behind it — the values
 * scrcpy's own client sends for the same gesture.
 */
export function encodeTouch(
    action: number,
    x: number,
    y: number,
    width: number,
    height: number,
): Buffer {
    const out = Buffer.alloc(32);
    out.writeUInt8(INJECT_TOUCH_EVENT, 0);
    out.writeUInt8(action, 1);
    out.writeBigUInt64BE(VIRTUAL_FINGER, 2);
    writePosition(out, 10, x, y, width, height);
    out.writeUInt16BE(pressureFixedPoint(action === ANDROID_TOUCH_UP ? 0 : 1), 22);
    out.writeInt32BE(0, 24);
    out.writeInt32BE(0, 28);
    return out;
}

/** Fixed-point scroll detents the way the server scales them back up. */
function scrollFixedPoint(detents: number): number {
    const clamped = Math.max(-1, Math.min(1, detents / 16));
    if (clamped >= 1) return 0x7fff;
    if (clamped <= -1) return -0x8000;
    return Math.round(clamped * 32768);
}

/** `INJECT_SCROLL_EVENT` at a point, in engine wheel detents. */
export function encodeScroll(x: number, y: number, width: number, height: number, dx: number, dy: number): Buffer {
    const out = Buffer.alloc(21);
    out.writeUInt8(INJECT_SCROLL_EVENT, 0);
    writePosition(out, 1, x, y, width, height);
    out.writeInt16BE(scrollFixedPoint(dx), 13);
    out.writeInt16BE(scrollFixedPoint(dy), 15);
    out.writeInt32BE(0, 17);
    return out;
}

/** `BACK_OR_SCREEN_ON`: the device Back key (and screen wake) for one action. */
export function encodeBackOrScreenOn(action: number): Buffer {
    return Buffer.from([BACK_OR_SCREEN_ON, action]);
}

/** The codec id the video stream must open with (`VideoCodec.H264`). */
export const SCRCPY_CODEC_H264 = 0x68323634;

/** Media packets: config is bit 62, key frame is bit 61, PTS the low 61 bits. (Session packets carry the top bit.) */
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;

/** One parsed video-socket frame: a new size, or one media payload. */
export type ScrcpyVideoEvent =
    | { type: 'size'; width: number; height: number }
    | { type: 'media'; config: boolean; keyframe: boolean; payload: Buffer };

const DEVICE_NAME_BYTES = 64;

/**
 * Video-socket bytes → sizes and payloads.
 *
 * Layout (v4.0 `Streamer`): one dummy byte, 64 bytes of device name, a u32
 * codec id, then 12-byte headers — a session packet (top bit set: flags, width,
 * height) or a media packet (pts-and-flags u64, size u32, payload). Payloads
 * are raw NAL units with no start codes; the feed assembler adds those.
 */
export class ScrcpyVideoParser {
    private buffer = Buffer.alloc(0);
    private preamble = 1 + DEVICE_NAME_BYTES + 4;

    push(chunk: Buffer): ScrcpyVideoEvent[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const events: ScrcpyVideoEvent[] = [];
        for (;;) {
            if (this.preamble > 0) {
                if (this.buffer.length < this.preamble) return events;
                const codec = this.buffer.readUInt32BE(this.preamble - 4);
                if (codec !== SCRCPY_CODEC_H264) {
                    throw new Error(`unsupported scrcpy video codec 0x${codec.toString(16)}`);
                }
                this.buffer = this.buffer.subarray(this.preamble);
                this.preamble = 0;
                continue;
            }
            if (this.buffer.length < 12) return events;
            if ((this.buffer.readUInt32BE(0) & 0x80000000) !== 0) {
                events.push({
                    type: 'size',
                    width: this.buffer.readUInt32BE(4),
                    height: this.buffer.readUInt32BE(8),
                });
                this.buffer = this.buffer.subarray(12);
                continue;
            }
            const ptsAndFlags = this.buffer.readBigUInt64BE(0);
            const size = this.buffer.readUInt32BE(8);
            if (size === 0 || size > 8 * 1024 * 1024) throw new Error(`bad scrcpy media size ${size}`);
            if (this.buffer.length < 12 + size) return events;
            events.push({
                type: 'media',
                config: (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n,
                keyframe: (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n,
                payload: this.buffer.subarray(12, 12 + size),
            });
            this.buffer = this.buffer.subarray(12 + size);
        }
    }
}

/** The Annex-B start code the engine's feed contract requires. */
const ANNEX_B = Buffer.from([0, 0, 0, 1]);

/**
 * Media payloads → one Annex-B access unit per feed call.
 *
 * Every payload becomes its own unit with a start code in front: config
 * payloads (SPS/PPS) travel as their own units ahead of the IDR that needs
 * them, which is exactly how the device's encoder emitted them.
 */
export function toAccessUnit(payload: Buffer): Buffer {
    return Buffer.concat([ANNEX_B, payload]);
}
