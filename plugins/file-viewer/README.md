# File viewer

Browse and read files in a git repository herdr already knows.

- **Phone:** a top-level **Files** destination. Pick a repo, list a directory, read a file.
- **Host:** read-only RPCs (`repos`, `list`, `read`) scoped to repo roots herdr reported. It does not search the whole disk.
- **Authority:** read-only. No write RPCs, no shell.
- **Offline:** hidden until the host reconnects.
- **Removal:** `herdr plugin unlink muxr.file-viewer`.
