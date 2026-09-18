# 🌊 Wave 2026-09-18 — Complete Product Overhaul

## Summary

This PR consolidates the entire wave of work completed on 2026-09-18. Fourteen pull requests were merged covering terminal smoothness, Home redesign, voice error handling, inline image support architecture, plugin contract hardening, and infrastructure improvements.

**This PR is a review document — it will be closed after review.**

## Merged PRs

| # | Title | What changed |
|---|-------|-------------|
| [#330](https://github.com/umeranjum17/muxr/pull/330) | Slash catalogue: rows not cards | Per-agent command rows with search, destructive confirms, phone bottom sheet |
| [#331](https://github.com/umeranjum17/muxr/pull/331) | Home on the design spine | One card grammar (radius 12, hairline), section labels, amber banner |
| [#332](https://github.com/umeranjum17/muxr/pull/332) | Layer alignment part 2 | Session shapes and profile moved to domain layer |
| [#333](https://github.com/umeranjum17/muxr/pull/333) | Dictation settings regrouped | Models, word replacements, provider groups, 10 languages |
| [#334](https://github.com/umeranjum17/muxr/pull/334) | Tests made able to fail | False-green check killed, fast 2-minute CI lane added |
| [#335](https://github.com/umeranjum17/muxr/pull/335) | Finished-unseen agents stay loud | Home separates done-not-opened from merely-recent |
| [#337](https://github.com/umeranjum17/muxr/pull/337) | Two perf tests that never ran now run | 15 tests, loud add-on-gated skip, proven failable |
| [#338](https://github.com/umeranjum17/muxr/pull/338) | Browser states + status line | Waiting, openFailed, unreachable states; 10 languages |
| [#339](https://github.com/umeranjum17/muxr/pull/339) | Kitty graphics removed entirely | 6,200 lines deleted; banner can never appear again |
| [#340](https://github.com/umeranjum17/muxr/pull/340) | Command palette fixes | Dead Enter row, heading a11y, honest Custom row, locale parity |
| [#343](https://github.com/umeranjum17/muxr/pull/343) | Spaces grouping | Children render under parents, 10 languages, a11y fixes |
| [#344](https://github.com/umeranjum17/muxr/pull/344) | Editable key row | Add/remove/reorder/custom keys, sticky modifiers, live preview |
| [#345](https://github.com/umeranjum17/muxr/pull/345) | Brittle test anchor fixed | Test reads exported function, not comment prose |
| [#347](https://github.com/umeranjum17/muxr/pull/347) | Voice errors explained in plain words | No more raw JSON; per-provider remedy; connecting ≠ failure |
| [#348](https://github.com/umeranjum17/muxr/pull/348) | Orb measurement fix | Measure instead of guess; no hand-typed heights |
| [#349](https://github.com/umeranjum17/muxr/pull/349) | Plugin opt-in marker | Home Right-now card requires explicit opt-in, not method name |
| [#350](https://github.com/umeranjum17/muxr/pull/350) | Charts caption a11y fix | Metric captions no longer announce as section headings |

## Key achievements

### Terminal smoothness investigation
Four research scouts investigated why Termux feels smooth and muxr doesn't. Findings: the RN frame scheduler (rAF + vsync) adds ~28ms of the 33ms total latency. Network, host, and relay are essentially free (<3ms combined). Termux achieves smoothness by drawing directly on a native view without any framework. The path forward is documented in the research reports.

### Plugin contract hardened
The Home Right-now card now requires an explicit opt-in marker instead of matching any plugin with a method named `now`. A render-side version gate ensures old plugins render their own card. A contract-breaking parse gate was identified and removed before shipping.

### Kitty graphics permanently removed
The entire graphics subsystem (6,200 lines) was deleted. The "Graphics stopped. Retry" banner can never appear again because the feature no longer exists.

### Testing infrastructure
- 2 perf tests that hadn't run since March now execute on every check
- A false-green test was killed and replaced with one that can actually fail
- A brittle test anchor was replaced with a structural one
- 15 perf tests now run including the previously-skipped warm-probe

## Waiting on captain review

| Item | Status |
|------|--------|
| #336 CI manual-dispatch only | Green; needs `suite` removed from branch protection |
| #342 Slash row tap target | Green; fixes regression from #340 |
| Workspace lineage (local branch) | Ready; 5 files, 88 lines; makes #343 actually group |
| Codex pane false-alarm fix (local branch) | Ready; pairs with upstream #4775 |
| 8 design docs | Awaiting captain review |

---

**This PR will be closed after review. It contains no code changes — it exists so the captain can review the wave summary with a single click.**
