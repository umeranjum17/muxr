// Records which tabs the extension was invoked on (action click or the
// declared shortcut). The viewer reports it alongside a capture so the
// service's transition record can say whether Chrome granted the tab by
// invocation or by the service's allowlist flag. Nothing else lives here:
// no capture, no recording, no network.
const invoked = new Map();
chrome.action.onClicked.addListener((tab) => { if (tab?.id !== undefined) invoked.set(tab.id, Date.now()); });
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === 'invoked') reply({ at: invoked.get(message.tabId) ?? null });
    return true;
});
