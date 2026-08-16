import { callPlugin } from '@/plugins/callPlugin';
import { boundRealtimeSession, realtimeConversationVisible, rememberedRealtimeSession, speak, speakWhenReady, startRealtimeSession, realtimeSessionSnapshot } from '@/realtime/realtimeSessionState';

/**
 * Voice's `speech.wake` capability: speaking needs the WebRTC session this app
 * owns, so the effect is native. Everything else is not — when it runs is the
 * manifest's trigger, and what it says comes back from the plugin's own RPC.
 */
export async function wakeAndReport(input: { sessionId: string; status: string; pane?: string }): Promise<void> {
    const live = realtimeSessionSnapshot().state !== 'disconnected';
    // Only the pane this conversation is about, and only where the user can see
    // it wake: a phone that starts talking from a background screen is a bug.
    const mine = boundRealtimeSession() ?? (realtimeConversationVisible() ? rememberedRealtimeSession() : null);
    if (mine !== input.sessionId) return;
    if (!live && !realtimeConversationVisible()) return;
    if (!live && !startRealtimeSession(input.sessionId)) return;

    const report = await callPlugin<{ say: string }>('voice.report', { status: input.status, pane: input.pane ?? '' });
    (live ? speak : speakWhenReady)(report.say);
}
