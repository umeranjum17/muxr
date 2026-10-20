# Select a terminal's text on iOS

On the native iOS app, a terminal's Select Text view shows the screen's text
in a read-only viewer: the system Select All (menu and Cmd+A) selects it all,
Copy puts the selection on the clipboard after one tap, and the edit menu
offers only read-only actions (Copy, Select All, Look Up, Translate, Search
Web, Learn, Share), never Cut, Paste or AutoFill.

## Sub-features

- `select-all` the menu's Select All, or Cmd+A on a hardware keyboard,
  selects the whole screen text.
- `copy-once` one tap on Copy puts exactly the selected text on the clipboard.
- `read-only-menu` the edit menu never shows Cut, Paste or AutoFill, and
  Cmd+V / Cmd+X change nothing.

## How to get to it (user POV)

- Open an agent or shell -> terminal actions -> Select text -> long-press or
  Cmd+A -> edit menu.

## Driving it with the private stack

Preconditions:

- The Release simulator app, lab and pairing from
  [accounts-ios.md](./accounts-ios.md) (its fake-Herdr panes are real shells,
  and Select Text reads the pane's screen through `pane.read`).

- **Seed.** Open the first pane, type `echo Umer select text check` in the
  composer and send it.
- **Open.** Terminal actions -> `Select text`; the viewer titled
  `Select Text` shows the pane text.
- **Menu.** Tap the text once, Cmd+A (`axe key-combo --modifiers 227 --key 4`),
  then tap the selection: the menu shows over it. Its `>` opens the full list.
  Screenshot both on an iPhone and an iPad simulator.
- **Caret menu.** Reopen the viewer, tap the text, tap the caret: the menu
  reads `Select | Select All` (no Paste even with text on the clipboard).
- **Copy.** Tap `Copy` once, then `xcrun simctl pbpaste <udid>` into a text
  file: it holds the exact viewer text.
- **Other fields.** Long-press an ordinary editable field (the terminal
  composer) with text on the clipboard: its menu still offers Paste.
- A before/after pair needs a native rebuild: the menu comes from
  `apps/mobile/ios/muxr/AppDelegate.swift`, not JS. React Native core ships
  prebuilt on iOS, so a `patches/react-native` hunk never reaches the app.

## Gotchas

- UIKit offers Select All only while part of the text is unselected, so a
  select-all menu has no Select All item; the caret menu shows it.
- Synthetic taps sometimes leave a stale full selection that no tap clears;
  go Back and reopen the viewer.
- The menu comes from the field having no keyboard (`showSoftInputOnFocus={false}`):
  any other multiline field with that prop gets the same read-only menu. If a
  React Native upgrade renames `RCTUITextView`, the stock menu comes back
  (Cut, Paste, AutoFill) without a crash: re-run this recipe after upgrades.
