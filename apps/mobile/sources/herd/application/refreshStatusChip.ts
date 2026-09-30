import { status, type ShowOptions } from '@byokit/statusbar';
import type { HerdNotificationState } from '../domain/herd';

// Action ids carry no display names. Resolve this key against the authorized tree
// after a cold start, instead of relying on a notification callback's old closure.
export function statusChipAgentKey(route: string): string {
    let hash = 14695981039346656037n;
    for (const character of route) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
    }
    return hash.toString(36);
}

// A queued control from a previous process must never control a new call whose
// in-memory epoch happens to be the same.
const processKey = Date.now().toString(36);
export function statusChipVoiceKey(generation: number): string {
    return `${processKey}_${generation}`;
}

interface ChipAgent { id: string; name: string; status: string; focused: boolean }

export interface StatusChipRefresh {
    herd: HerdNotificationState;
    voiceState: string;
    voiceName: string;
    muted: boolean;
    agents: ChipAgent[];
    voiceGeneration: number;
}

/** Product copy and controls; BYOKit owns the notification's platform lifecycle. */
export function refreshStatusChip(current: StatusChipRefresh): { active: boolean; attentionRoute: string | null } {
    const { herd, voiceState, voiceName, muted, agents, voiceGeneration } = current;
    const visible = agents.filter((agent) => !agent.focused);
    const blocked = visible.filter((agent) => agent.status === 'blocked');
    const working = visible.filter((agent) => agent.status === 'working' || agent.status === 'starting');
    const focused = agents.find((agent) => agent.focused);
    const focusedActive = focused !== undefined && (focused.status === 'blocked' || focused.status === 'working' || focused.status === 'starting');
    const suppressFocused = focusedActive && (herd.mode === 'working' || herd.mode === 'attention');
    const shown = herd.mode === 'attention' && blocked.length > 0 ? blocked : working;
    const count = suppressFocused ? shown.length : herd.count;
    const attention = herd.mode === 'attention' && (!suppressFocused || blocked.length > 0);
    const attentionRoute = attention && count === 1 ? blocked[0]?.id ?? null : null;
    const activeVoice = voiceState !== 'disconnected';
    const active = activeVoice || herd.mode === 'working' || herd.mode === 'attention';
    if (!active) {
        status.clear();
        return { active, attentionRoute: null };
    }
    const names = (suppressFocused ? shown.map((agent) => agent.name).join(', ') : herd.names).trim().replace(/\s+/g, ' ').slice(0, 160);
    const name = (suppressFocused ? shown[0]?.name ?? '' : names.split(',')[0]).trim().slice(0, 80) || 'An agent';
    let options: ShowOptions;
    if (activeVoice) {
        let text = 'Listening';
        let chip = 'Live';
        if (voiceState === 'connecting') text = 'Connecting';
        if (voiceState === 'thinking') { text = 'Thinking'; chip = 'Think'; }
        if (voiceState === 'speaking') { text = 'Speaking'; chip = 'Speak'; }
        if (muted) { text = 'Microphone muted'; chip = 'Muted'; }
        options = {
            title: voiceName.trim() ? `Voice with ${voiceName.trim().slice(0, 80)}` : 'muxr Voice',
            text, chip, publicText: text,
            actions: [
                { id: `stop_${statusChipVoiceKey(voiceGeneration)}`, label: 'Hang Up' },
                { id: `mute_${statusChipVoiceKey(voiceGeneration)}_${Number(!muted)}`, label: muted ? 'Unmute' : 'Mute' },
            ],
            promote: true, timeoutMs: 15 * 60_000, icon: 'notification_icon',
        };
    } else {
        let title = count === 1 ? `${name} is working` : `${count} agents working`;
        let text = count > 1 && names ? names : 'Work in progress';
        let chip = count > 0 && count < 10 ? `${count} busy` : 'Busy';
        let publicText = count === 1 ? '1 agent working' : `${count} agents working`;
        if (count === 0) { title = 'muxr'; text = 'Keeping agents connected'; chip = ''; publicText = 'Agents connected'; }
        if (attention) {
            title = count === 1 ? `${name} needs you` : `${count} agents need you`;
            text = 'Open muxr to respond'; chip = 'Needs';
            publicText = count === 1 ? 'An agent needs you' : `${count} agents need you`;
        }
        options = {
            title, text, chip, publicText,
            actions: attention ? [{ id: attentionRoute === null ? 'open' : `open_${statusChipAgentKey(attentionRoute)}`, label: 'Open' }, { id: 'talk', label: 'Talk' }] : [{ id: 'talk', label: 'Talk' }],
            promote: true, timeoutMs: 15 * 60_000, icon: 'notification_icon',
        };
    }
    status.show(options);
    return { active, attentionRoute };
}
