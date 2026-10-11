# Privacy Policy

## Connections and end-to-end encryption

muxr connects your phone to a host on a computer you operate through a relay you run, either on that computer or on your own VPS. LAN, Tailscale, and your own reverse proxy are ways to reach it. The connection is end-to-end encrypted, including pairing. muxr does not operate an account, relay, email login, or cloud service for the app. Your computer remains the source of truth for agents, terminals, files, and plugins.

Your relay can see network addresses, routing metadata, machine and device identifiers, connection timing, and ciphertext sizes, but not terminal text, prompts, responses, keystrokes, file contents, attachment plaintext, machine data keys, or pairing secrets. Network services you choose to put in front of it may also see connection metadata.

A paired native device is equivalent to access to your user shell. Protect and revoke devices accordingly. Third-party plugins run as your computer user and should be reviewed before installation.

## Voice providers

Realtime voice is optional. The default is experimental Codex Voice, using your existing Codex CLI login on the computer; you can choose another supported provider instead. Voice credentials or an existing CLI login stay on your computer, not in the phone or relay. When you use realtime voice, audio goes to that provider, along with the system prompt, tool schemas, requested tool arguments, and tool output needed for the conversation. Tool output can include terminal excerpts you ask the agent to inspect. Your provider's billing, retention, and data controls apply.

Local dictation uses the bundled Whisper model and keeps audio on the phone.

## Local usage reports

The Usage screen runs the exact pinned ccusage backend in offline/no-cost mode. ccusage reads local coding-agent logs on your computer. muxr renders only allowlisted agent names and rounded token totals for today and caches only the final bounded card text for one minute in muxr's owner-only state directory; it does not render costs, prompts, model names, projects, or session details. Codex current-limit percentages come from Codex's local app-server. Other coding CLIs are detected by executable name and are never launched.

## Retention and deletion

The muxr maintainers do not receive or retain your agent content. Pairing credentials and preferences remain on your device until you revoke the device, reset muxr, or uninstall the app. Your computer retains host state, attachments, and optional provider credentials until you remove them.

Your self-hosted relay retains data according to your configuration. If you enable iPhone push notifications, your Expo push token and the notification title, body, and data go through your relay to Expo's push service and Apple's push notification service. The title can be a task title, and the body names the agent and its status. The data includes an event ID, status, agent name, session and machine IDs, a push routing marker, and, when available, task title and reason code. Expo and Apple can process this content and delivery metadata; it is not end-to-end encrypted agent content. Android uses local notifications, not this Expo/Apple push path, so Google's push service does not receive these notifications. A voice provider you choose receives the voice data described above and applies its own retention policy. Revoking a machine or device prevents it from minting new connections. Removing muxr state does not delete your Herdr workspaces or source repositories, or delete data held by a voice provider.

## Website

The website has no analytics, advertising scripts, service worker, account checkout, or client-side secrets. The hosting network may process ordinary request metadata such as IP address, timestamp, path, and user agent for delivery, abuse prevention, and operational logs.

## Contact

muxr is maintained by the open-source muxr project. Ask privacy questions through the [public issue tracker](https://github.com/umeranjum17/muxr/issues); report sensitive security or privacy issues through a [private GitHub security advisory](https://github.com/umeranjum17/muxr/security/advisories/new).
