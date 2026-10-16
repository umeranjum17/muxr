# Send any file from the phone to a live agent

The session composer's and Home's `+` attach control offers `Photo Library` and
`Files`. An image keeps its current path — resized, JPEG-re-encoded, shown as a
thumbnail. Any other file (zip, pdf, txt, binary) is written to the host under
the session's attachments directory with its original name and extension, and
the agent receives the absolute path appended to the prompt, exactly as images
already were. A file over the per-file cap is refused on the phone, naming the
file and the limit.

## Sub-features

- `attach-image` unchanged: photo picked, resized to 1568 px, thumbhash
  placeholder, uploaded, path appended on send.
- `attach-file` a document picked via the system picker (native) or the file
  input (installed PWA) shows a file chip with its name, size and type icon in
  the composer, removable before send.
- `attach-host-name` the host stores the original (sanitised) name and
  extension under `$MUXR_HOME/host/attachments/<digest>/<folder>/`, where
  `<digest>` is an opaque per-session folder name — the internal pane id
  (pp_…) never appears in a saved path. Two files with the same name never
  overwrite — the second gets `-1` before the extension.
- `attach-agent-path` a live agent reads the file at the path in the prompt
  (listing the zip, reading the PDF text, printing the txt) with **no
  permission prompt**: muxr's own attachment folder is pre-allowed
  (`external_directory` allow — OpenCode's folder grant has no read/write
  split, and its edit globs match project-relative paths only, so no deny
  rule for this external folder exists) in the account's OpenCode config
  at launch, or, without an account, as the pane's `OPENCODE_CONFIG_CONTENT`
  carrying the user's own rules (none when the host already sets it or a
  config will not parse — the prompt then stays); other agents already read
  external paths silently.
- `attach-too-large` a file over the 10 MB cap is refused before upload with a
  plain alert naming the file and the cap; nothing is written host-side.
- `attach-host-backstop` a request that skips the phone cap is refused by the
  host with `attachment-too-large`.
- `attach-survives-leaving` a chip leaves with its agent screen and comes back
  with the draft text: attach, go Home, reopen the agent, the chip is there and
  Send carries its path. Sending (or clearing) the draft clears the chip too.

## How to get to it (user POV)

Open an agent (or Home), tap `+`, choose `Files`; pick one or more documents.
Each shows as a chip under the composer. Send — the prompt carries the paths.

## Driving it with the private stack

Preconditions:

- A release APK from `node perf/buildPrApk.mjs <out>` on a task-owned emulator,
  and a real-Herdr lab (`HERDR_LAB_HELPER`) with a live agent pane, paired to a
  task-private `MUXR_HOME`/`MUXR_DATA_DIR`.
- Create fixtures outside the worktree: a `.zip` (`zip -r bundle.zip .`), a text
  `.pdf` and a `.txt`.

1. Open the live agent, tap `+`, choose `Files`, pick `bundle.zip`, `sample.pdf`,
   `notes.txt`. Confirm three chips with names, sizes and type icons appear and
   each is removable. Send one prompt.
2. On the host, list `$MUXR_HOME/host/attachments/`: a 16-hex digest folder
   (not `pp_…`) holds `<folder>/` with the three files, original names, `cmp`
   identical bytes. No path anywhere (prompt, terminal) shows `pp_`.
3. In the agent's TUI, run the command that opens each path: `unzip -l` on the
   zip, `pdftotext`/a cat of the pdf text, `cat` on the txt. Capture the agent
   printing each. On OpenCode there must be **no** "Access external directory"
   prompt and no "Needs you" header for these reads.
4. Repeat with a file just over 10 MB: the phone refuses it with the plain
   alert; the host directory is unchanged.
5. Installed PWA: the same flow at 393 and 270 px, light and dark, chips and the
   refusal. Run the skill's Visual check on the composer with a file chip.
6. Leaving keeps the chip: in a shell pane of the lab type `ls -l`, attach an
   image, tap Back to Home, reopen the pane. The composer shows `ls -l` and the
   chip; Send runs `ls -l <host path>` and the shell lists the saved file. On a
   build without the fix the chip is gone and the shell gets a bare `ls -l`.
   Reopen once more after sending: no chip and no text come back.

## Gotchas

- The picker is only reachable from a user gesture; a PWA file input opened
  without one is ignored by the browser.
- Native pickers may omit a file's size (`size=0`); that file passes the phone
  check and only the host backstop can refuse it.
- The host writes into the pane's session directory resolved from the session
  record; a client can never choose the directory. An all-dots or
  separator-bearing name is neutralised to `attachment`.
- Files upload one request each: a whole batch in one frame can pass the link's
  16 MB per-message reassembly ceiling.
- Opening or previewing a sent file inside muxr is out of scope; the phone chip
  is not tappable for a preview.
