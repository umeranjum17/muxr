import { callPlugin } from '@/plugins/callPlugin';
import { realtimeWatchTarget, speak, speakWhenReady, startRealtimeSession, realtimeSessionSnapshot } from '@/realtime/realtimeSessionState';

/**
 * Voice's `speech.wake` capability: speaking needs the WebRTC session this app
 * owns, so the effect is native. Everything else is not — when it runs is the
 * manifest's trigger, and what it says comes back from the plugin's own RPC.
 */
export async function wakeAndReport(input: { sessionId: string; status: string; pane?: string }): Promise<void> {
    const live = realtimeSessionSnapshot().state !== 'disconnected';
    // “Go to sleep” closes the paid provider stream but leaves this local watch
    // attached to one pane until the user explicitly ends the realtime UI.
    if (realtimeWatchTarget() !== input.sessionId) return;
    if (!live && !startRealtimeSession(input.sessionId)) return;

    const report = await callPlugin<{ say: string }>('voice.report', { status: input.status, pane: input.pane ?? '' });
    (live ? speak : speakWhenReady)(report.say);
}
