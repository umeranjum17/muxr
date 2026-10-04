# Artifact pages: publish and update an HTML page

Use this when an agent's result reads best as one page: an evidence or status
page with screenshots, a report with charts, a before/after comparison. The
page is an artifact in the pane's Shared Artifacts history, so it reuses the
same storage, pairing, and phone screen. It needs no new server or account.

```bash
muxr share evidence.html --title "Release evidence"   # first time: v1
# ...edit evidence.html, swap the screenshots...
muxr share evidence.html --title "Release evidence"   # same title: v2
```

- **One command, one file.** Every `<img src="…">` in the page must be a png,
  jpeg, webp, or gif file inside the page's own folder. The command inlines each
  one, so each version is a single self-contained file. A remote URL, an
  absolute path, or a path that leaves the folder (`../`, a symlink pointing
  outside) is refused with an error. Nothing is fetched later.
- **Same title, same artifact.** The title is the page's identity in the pane.
  Sharing again with the same title adds the next version (`Shared Release
  evidence v2`). Earlier versions are never overwritten or removed. Without
  `--title`, the filename is the title.
- **On the phone.** The session's Shared Artifacts list shows each page once, at
  its latest version, with a `N versions` link to the version history. A page
  opens in the app's read-only preview: scripts, `<style>` blocks, links, and
  remote content are removed. Use inline `style=""` attributes for styling. A
  version opened once stays readable offline.
- **Limits.** 8 MB per version with images inlined. Every version counts toward
  the pane's newest-50 list and the retention sweep, so republish when the page
  has really changed, not on every small edit.
