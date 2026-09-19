# Usage quota evidence

Candidate: `fm/pock-usage-quotas1` at the committed implementation change.

- Before reference: `docs/screenshots/v015/usage.png` (the original Usage path with token activity and rate-limit content below it).
- PWA, 390x844 CSS px, dark/light: `usage-quotas1-pwa-dark.png`, `usage-quotas1-pwa-light.png` (unavailable-plan state).
- PWA, 390x844 CSS px, Claude fixture with real declarative host output: `usage-quotas1-pwa-claude-dark.png`, `usage-quotas1-pwa-claude-light.png`. It shows the 5-hour and 7-day windows first, normalized used values, a 100% bar ceiling, reset labels, and the activity-unavailable notice below the quota decision.
- Native Android dev client on isolated emulator `emulator-5582`: `usage-quotas1-native-270-dark.png` and `usage-quotas1-native-360-dark.png` at 270dp/360dp-equivalent display sizes; `usage-quotas1-native-360-claude-dark.png` and `usage-quotas1-native-360-claude-font130-dark.png` cover populated multi-window quotas at default and 1.3 font scale. `usage-quotas1-native-270-claude-font130-dark.png` covers the 270dp 1.3-scale narrow layout and unavailable-plan state.
- Settings › Plugins: `usage-quotas1-plugins-dark.png` shows icon tiles, one-line descriptions, and a mono facts line.

The native emulator was isolated from the captain devices and connected only to the lab host/relay. No credentials or quota payloads are included in this evidence note or filenames.
