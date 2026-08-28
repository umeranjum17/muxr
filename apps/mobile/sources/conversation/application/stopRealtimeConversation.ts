export type StopRealtimeConversationPorts = {
    endWatch: () => void;
    interruptPlayback: () => void;
};

export type StopRealtimeConversationResult = { ok: true };

/** End the speech-to-speech call and its Agent Watch on this device. */
export function stopRealtimeConversation(
    ports: StopRealtimeConversationPorts,
): StopRealtimeConversationResult {
    ports.endWatch();
    ports.interruptPlayback();
    return { ok: true };
}
