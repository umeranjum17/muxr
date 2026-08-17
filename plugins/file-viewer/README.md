# File viewer

Browse and read files in a git repository herdr already knows.

- **Phone/web:** a top-level **Files** destination. Pick a repo, browse its tree, and read a bounded, selectable preview with line numbers, automatic syntax highlighting, and a safe plain-text fallback.
- **Host:** read-only RPCs (`repos`, `list`, `read`) scoped to repo roots herdr reported. It reads at most 24 KiB / 240 lines for a preview, reports truncation, and never scans the whole disk or loads a whole large file.
- **Authority:** read-only. No write RPCs, no shell.
- **Offline:** hidden until the host reconnects.
- **Removal:** `herdr plugin unlink muxr.file-viewer`.
