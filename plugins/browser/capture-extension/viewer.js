/**
 * Trusted extension document of the muxr browser service.
 *
 * Opened by the service (never by a site or the agent) with a one-launch
 * token in the URL fragment. It captures exactly the tab the service names
 * with `tabCapture.getMediaStreamId({targetTabId})`, verifies the tab is
 * the one the service registered before and after capture, feeds the track
 * straight into an RTCPeerConnection answering the owner device's offer,
 * and forwards the device's data-channel intents to the service, which is
 * the only thing that ever dispatches input. No audio, no MediaRecorder, no
 * screenshots. The channel to the service is loopback-only and
 * token-authenticated; everything the device sees rides DTLS-SRTP.
 */
const params = new URLSearchParams(location.hash.slice(1));
const port = params.get('port');
const token = params.get('token');
const base = `http://127.0.0.1:${port}`;

const state = { stream: null, track: null, pc: null, generation: 0, tabId: null, channels: {} };

async function post(body) {
    await fetch(`${base}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

async function tabUrl(tabId) {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ?? '';
}

function stopCapture() {
    if (state.pc) { try { state.pc.close(); } catch { /* closing */ } }
    if (state.stream) for (const track of state.stream.getTracks()) track.stop();
    state.pc = null;
    state.stream = null;
    state.track = null;
    state.channels = {};
}

async function capture({ tabId, url, width, height, fps }) {
    if ((await tabUrl(tabId)) !== url) throw new Error('tab mapping changed before capture');
    const invoked = await chrome.runtime.sendMessage({ type: 'invoked', tabId }).catch(() => ({ at: null }));
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: width, maxHeight: height, maxFrameRate: fps } },
    });
    if ((await tabUrl(tabId)) !== url) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error('tab mapping changed during capture');
    }
    const track = stream.getVideoTracks()[0];
    if (state.pc && state.track) {
        const sender = state.pc.getSenders().find((entry) => entry.track === state.track);
        if (sender) await sender.replaceTrack(track);
        if (state.stream) for (const old of state.stream.getTracks()) old.stop();
    }
    state.stream = stream;
    state.track = track;
    state.tabId = tabId;
    track.onended = () => post({ event: 'capture-ended', generation: state.generation });
    return { settings: track.getSettings(), invocation: invoked?.at ? 'invoked' : 'allowlisted' };
}

function preferCodec(transceiver) {
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || typeof transceiver.setCodecPreferences !== 'function') return 'unknown';
    const h264 = caps.codecs.filter((codec) => codec.mimeType === 'video/H264');
    const vp8 = caps.codecs.filter((codec) => codec.mimeType === 'video/VP8');
    const chosen = h264.length > 0 ? h264 : vp8;
    if (chosen.length === 0) return 'unknown';
    const aux = caps.codecs.filter((codec) => codec.mimeType === 'video/rtx' || codec.mimeType === 'video/red' || codec.mimeType === 'video/ulpfec');
    transceiver.setCodecPreferences([...chosen, ...aux]);
    return chosen[0].mimeType;
}

function fingerprintOf(sdp) {
    const match = /a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/.exec(sdp);
    return match ? `${match[1]} ${match[2]}` : '';
}

function wireChannel(channel) {
    state.channels[channel.label] = channel;
    // The service pushes geometry and focus once the control lane is open.
    channel.onopen = () => void post({ event: 'channel', generation: state.generation, channel: channel.label });
    channel.onmessage = (event) => {
        if (typeof event.data !== 'string' || event.data.length > 16 * 1024) return;
        let intent;
        try { intent = JSON.parse(event.data); } catch { return; }
        void post({ event: 'input', generation: state.generation, channel: channel.label, intent });
    };
}

async function answer({ generation, sdp }) {
    if (!state.track) throw new Error('nothing is captured');
    if (state.pc) { try { state.pc.close(); } catch { /* replacing */ } }
    state.generation = generation;
    const pc = new RTCPeerConnection({ iceServers: [] });
    state.pc = pc;
    pc.onicecandidate = (event) => {
        if (event.candidate) void post({ event: 'ice', generation, candidate: event.candidate.toJSON() });
    };
    pc.ondatachannel = (event) => wireChannel(event.channel);
    pc.onconnectionstatechange = () => void post({ event: 'peer', generation, connection: pc.connectionState });
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const sender = pc.addTrack(state.track, state.stream);
    const transceiver = pc.getTransceivers().find((entry) => entry.sender === sender);
    const codec = transceiver ? preferCodec(transceiver) : 'unknown';
    const local = await pc.createAnswer();
    await pc.setLocalDescription(local);
    // The device's offer arrived complete and its signal channel is a
    // request/reply relay, so the answer must be complete too: gather
    // before replying (bounded) instead of trickling into the void.
    await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const timer = setTimeout(resolve, 2_000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
    });
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'balanced';
    parameters.encodings = [{ ...(parameters.encodings?.[0] ?? {}), maxBitrate: 4_000_000, maxFramerate: 60 }];
    await sender.setParameters(parameters).catch(() => undefined);
    return { sdp: pc.localDescription.sdp, fingerprint: fingerprintOf(pc.localDescription.sdp), codec };
}

async function handle(command) {
    switch (command.cmd) {
        case 'map': {
            const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url === command.marker);
            if (tabs.length !== 1) throw new Error('registered tab is not unique');
            return { tabId: tabs[0].id, windowId: tabs[0].windowId };
        }
        case 'verify':
            return { url: await tabUrl(command.tabId) };
        case 'opener': {
            const tab = await chrome.tabs.get(command.tabId).catch(() => null);
            return { openerTabId: tab?.openerTabId ?? null, url: tab?.url ?? '' };
        }
        case 'child': {
            const tabs = (await chrome.tabs.query({})).filter((tab) => tab.openerTabId === command.openerTabId && tab.url === command.url);
            return { tabId: tabs.length === 1 ? tabs[0].id : null };
        }
        case 'capture':
            return capture(command);
        case 'answer':
            return answer(command);
        case 'ice':
            if (state.pc && state.generation === command.generation) await state.pc.addIceCandidate(command.candidate);
            return {};
        case 'send': {
            const channel = state.channels[command.channel];
            if (channel && channel.readyState === 'open' && state.generation === command.generation) channel.send(JSON.stringify(command.data));
            return {};
        }
        case 'stop':
            stopCapture();
            return {};
        default:
            throw new Error('unknown command');
    }
}

const events = new EventSource(`${base}/events?token=${encodeURIComponent(token)}`);
events.onmessage = (event) => {
    let command;
    try { command = JSON.parse(event.data); } catch { return; }
    handle(command).then(
        (result) => post({ id: command.id, ok: true, result }),
        (error) => post({ id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
};
