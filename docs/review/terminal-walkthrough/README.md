# The completed terminal experience, walked through

**This pull request is disposable. It is for review only and must not be merged.**
It adds one walkthrough document and its screenshots. It changes no product
source, no behaviour, no dependency, no generated package, no release automation
and no live configuration.

Every capture below is of the exact candidate `38b52b23` — the merge of the
completed compact-header and bottom-composer work plus the terminal work that
landed with it. Nothing here is a mock: each frame is a real screen driven
through its real controls against a private relay, host and Herdr session, on
private ports, with an isolated muxr data directory.

## What you can now do

- **See where you are at a glance.** The session header is one compact row: the
  pane's name, what is running in it, its lifecycle word when it has one, and
  the pane pager that opens the rest.
- **Keep the composer close.** A single bottom rail holds the key row, the
  draft, dictation and Send, and it never leaves the screen at either phone
  width.
- **Know why nothing was sent.** Enter on a pane with no agent is refused on the
  device — "No agent in this pane" — and the draft you typed stays exactly where
  it was.
- **Arrange the keys you actually press.** The built-in row scrolls, the editor
  reorders it by dragging a handle, and Paste and Hide keyboard ride along as
  action keys that never pretend to send terminal bytes.
- **Reach the quick actions with one thumb.** The floating puck fans out the
  ring over the terminal and collapses back.
- **Use a link the way you would at the desk.** Open one from pane actions, or
  hold the underlined URL in the output to copy it.
- **Reuse what the terminal already printed.** Pick a line in history and it
  lands in the visible draft; nothing runs until you send it.
- **Write your own replies.** They are device-local, reorderable, and announced
  as insert-only: a tap puts the text in the draft and never sends.
- **Paste once, hide the keyboard once.** Both are single taps on the key rail;
  neither leaves a setting behind.

## 1. The compact header

The header is one row on both phone widths (`4–48 dp` at 270 dp wide, the same
at 360 dp). A shell pane names the pane and its kind and says nothing about
lifecycle, because a live shell has no lifecycle to report.

![Shell pane with the compact header and an idle composer](01-shell-header-composer-idle-270dp.png)

An agent pane carries the same row plus the lifecycle word when there is one to
give — see [section 9](#9-a-genuine-working-state).

![Agent pane, compact header, idle](27-agent-header-idle-270dp.png)

## 2. The bottom composer

Idle, focused, and holding a pasted draft. At 270 dp the whole rail is
`494–589 dp`: key row, then the draft field, dictation, Send.

![Composer focused](02-composer-focused-270dp.png)

A one-tap Paste puts the clipboard into the draft. The field is a single line,
so a multi-line paste reads as one line in it — the draft itself keeps the line
breaks, and they arrive intact at the other end (evidence in
[Notes](#notes-on-the-evidence)).

![Composer holding a pasted draft](03-composer-pasted-draft-270dp.png)

## 3. What happens when the pane has no agent

Enter on a pane with no agent is refused on the device. The refusal is a quiet
hint, nothing reaches the shell, and the draft is still there afterwards:

![Shell pane refuses Enter](04-shell-enter-refusal-270dp.png)

The same draft, unchanged, in the same field after the refusal.

## 4. The key row and the key editor

The built-in row is eleven keys wide, so it scrolls. Start of the row:

![Key rail, start of the row](05-key-rail-start-270dp.png)

End of the row, where the two action keys live:

![Key rail, action keys](06-key-rail-action-keys-270dp.png)

The editor lists the live row with drag handles, a live preview and a way to
add a key:

![Key editor](07-key-editor-list-270dp.png)

Holding a handle lifts the row and the list swaps underneath it:

![Key editor, reorder in flight](08-key-editor-reorder-in-flight-270dp.png)

The new order is committed to the device:

![Key editor, new order stored](09-key-editor-reordered-270dp.png)

An action key explains itself instead of offering a chord it cannot express:

![Key form: Paste action key](10-key-form-paste-action-270dp.png)
![Key form: Hide keyboard action key](11-key-form-hide-keyboard-270dp.png)

Removing a key takes it off the row, and "Reset to the default row" puts the
built-in row back:

![Key editor, key removed](12-key-editor-removed-paste-270dp.png)
![Default key row restored](13-key-rail-default-row-270dp.png)

## 5. The command ring

One puck, resting inside the terminal, opens the ring; each slot fires on lift:

![Command ring open](14-command-ring-open-270dp.png)

On the web build the ring carries the three slots that make sense there —
Continue, Review changes, Browser. The fourth slot, Keyboard, is a native-only
affordance.

## 6. Links printed in the output

Everything found in the pane is listed under pane actions:

![Pane actions: link rows](15-pane-actions-link-rows-270dp.png)
![Open-link sheet](16-open-link-sheet-270dp.png)

Holding the underlined URL in the output copies it, and the terminal says so:

![Link copied](17-link-copied-chip-270dp.png)

## 7. Reusing a line from history

History rows offer the line next to them:

![History: insert affordances](18-history-insert-affordances-270dp.png)
![History: row chosen](19-history-row-to-insert-270dp.png)

Picking one returns to the terminal with the exact line appended to the draft
that was already there — and nothing sent:

![History: line inserted into the draft](20-history-inserted-draft-270dp.png)

## 8. Your own quick replies

Starting from nothing:

![Quick replies, empty](21-quick-replies-empty-270dp.png)

Two added, then the same drag handle reorders them, editing saves new text, and
removing takes one off the list:

![Quick replies, two added](22-quick-replies-two-270dp.png)
![Quick replies, reordered](23-quick-replies-reordered-270dp.png)
![Quick replies, edited and removed](24-quick-replies-after-edit-and-remove-270dp.png)

In the command palette a personal reply announces what it does — it is
insert-only, and the row says so:

![Personal reply in the command palette](25-quick-reply-in-palette-270dp.png)

Tapping it fills the draft and stops there:

![Personal reply inserted, unsent](26-quick-reply-inserted-unsent-270dp.png)

## 9. A genuine Working state

The agent pane opens idle:

![Agent pane, compact header, idle](27-agent-header-idle-270dp.png)

A pasted draft waits in the composer on an agent pane too:

![Agent pane: pasted draft](28-agent-composer-pasted-draft-270dp.png)

Sending, then reopening the screen while the agent is still working, gives the
real lifecycle word in the header:

![Agent pane, compact header, Working](29-agent-header-working-270dp.png)

## The same screens at 360 dp

The second real PWA layout. Nothing overlaps and the composer stays the last
rail of the screen at this width too.

| | |
|---|---|
| ![Header and idle composer](01-shell-header-composer-idle-360dp.png) | ![Composer focused](02-composer-focused-360dp.png) |
| ![Composer holding a pasted draft](03-composer-pasted-draft-360dp.png) | ![Shell pane refuses Enter](04-shell-enter-refusal-360dp.png) |
| ![Key rail, start of the row](05-key-rail-start-360dp.png) | ![Key rail, action keys](06-key-rail-action-keys-360dp.png) |
| ![Key editor](07-key-editor-list-360dp.png) | ![Key editor, reorder in flight](08-key-editor-reorder-in-flight-360dp.png) |
| ![Key editor, new order stored](09-key-editor-reordered-360dp.png) | ![Key form: Paste action key](10-key-form-paste-action-360dp.png) |
| ![Key form: Hide keyboard action key](11-key-form-hide-keyboard-360dp.png) | ![Key editor, key removed](12-key-editor-removed-paste-360dp.png) |
| ![Default key row restored](13-key-rail-default-row-360dp.png) | ![Command ring open](14-command-ring-open-360dp.png) |
| ![Pane actions: link rows](15-pane-actions-link-rows-360dp.png) | ![Open-link sheet](16-open-link-sheet-360dp.png) |
| ![Link copied](17-link-copied-chip-360dp.png) | ![History: insert affordances](18-history-insert-affordances-360dp.png) |
| ![History: row chosen](19-history-row-to-insert-360dp.png) | ![History: line inserted into the draft](20-history-inserted-draft-360dp.png) |
| ![Quick replies, empty](21-quick-replies-empty-360dp.png) | ![Quick replies, two added](22-quick-replies-two-360dp.png) |
| ![Quick replies, reordered](23-quick-replies-reordered-360dp.png) | ![Quick replies, edited and removed](24-quick-replies-after-edit-and-remove-360dp.png) |
| ![Personal reply in the command palette](25-quick-reply-in-palette-360dp.png) | ![Personal reply inserted, unsent](26-quick-reply-inserted-unsent-360dp.png) |
| ![Agent pane, compact header, idle](27-agent-header-idle-360dp.png) | ![Agent pane: pasted draft](28-agent-composer-pasted-draft-360dp.png) |
| ![Agent pane, compact header, Working](29-agent-header-working-360dp.png) | |

## Layout numbers behind the frames

| | 270 dp | 360 dp |
|---|---|---|
| Header row | `y 4–48` | `y 4–48` |
| Key row top | `y 494` | `y 540` |
| Draft field | `78 × 34` wide | `168 × 34` wide |
| Composer bottom | `y 589` | `y 635` |
| Viewport | `270 × 594` | `360 × 640` |

## Notes on the evidence

- Every frame was taken after the screen itself was checked in the page: the
  header's accessible name, the ring's open state, the stored key row in local
  settings, the exact draft text in the field. A frame is only kept if the check
  it belongs to passed in the same run.
- **The multi-line draft really is delivered whole.** The composer is a
  single-line field, so a pasted multi-line draft reads as one line on screen —
  but the draft carries its line breaks. A three-line draft pasted with the
  key rail's Paste key and sent to a live agent arrived at that agent with all
  three line breaks intact.
- The shell pane's Send control stays inert (a pane with no agent has nothing to
  prompt); the refusal in [section 3](#3-what-happens-when-the-pane-has-no-agent)
  is the Enter path, which is refused on the device before anything is sent.
- Screenshots are framed at device pixel ratio 3, so type is legible at review
  size. Pairing strings, credentials, device identifiers and host addresses are
  not present in any frame.

## Known gap: the physical-phone lane

The native-only states are **not** in this walkthrough. The development client
was pointed at the same private lab (its own screen reports the candidate source
`38b52b23`), and it reaches the private relay, but it never exchanges a frame
with the private host: the home screen stays on "Reconnecting…", the Panes
screen stays on "Loading panes…", and no data arrives. Because of that, three
things a browser cannot show are missing here:

1. the compact in-composer dictation presentation;
2. one-tap keyboard hiding;
3. the four-slot ring, whose fourth slot (Keyboard) exists only on a device.

Nothing was substituted for them: no emulator, no mock, no staged screenshot.
They are recorded as follow-up work rather than repaired in this branch, which is
review-only.

## Follow-ups

- **Wire up the native capture lane and take the three frames above.** The lab
  works end to end in the browser; the gap is the device-to-host session, not
  the screens.
- **The composer is one line.** A multi-line draft is preserved and sent
  faithfully, but on screen it reads as a single line in a field that is 78 dp
  wide at the narrow phone width. If a multi-line draft should be *readable*
  before sending, that is a product change, not a walkthrough change.
