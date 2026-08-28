export type InterruptPlaybackPorts = {
    stop: () => void;
};

export type InterruptPlaybackResult = { ok: true };

/** Stop native Realtime Playback for the current Stream Generation. */
export function interruptPlayback(ports: InterruptPlaybackPorts): InterruptPlaybackResult {
    ports.stop();
    return { ok: true };
}
