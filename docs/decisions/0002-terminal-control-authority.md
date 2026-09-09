# 0002 — One explicit controller per terminal pane

Tier: T3 (command authority)  
Status: accepted  
Date: 2026-08-12  
Decider: Umer

## Decision

Each pane has at most one phone control stream. Opening a terminal or tapping its visible retry after displacement is an explicit takeover action. Automatic reconnect, app foreground, repaint, and network recovery may restore the same device's control but MUST NOT displace another device. Different panes may be controlled concurrently. Observe streams are read-only and never displaced.

The host, not the client, serializes same-pane attach requests and enforces takeover intent against the relay-authenticated device. A successful successor receives control only after its channel and Herdr process are ready. The prior controller receives `terminal.closed: control moved to another device`; automatic reattach is suppressed. Input and detach remain bound to the authenticated device/channel.

## Alternatives

- Concurrent writers: rejected because interleaved commands and resizes are unsafe.
- Silent last-writer-wins: rejected because reconnect races can repeatedly steal control.
- A second confirmation dialog: deferred; opening the terminal or tapping retry is already a direct, reversible control action. Add only if evidence shows accidental takeovers.

## Evidence and standards

Complete mediation at the host, per-pane mutual exclusion, and TOCTOU-safe serialization. The terminal-control flows prove automatic cross-device attach rejection, explicit displacement, observer survival, stale-input fencing, authenticated input, device-bound detach, automatic retry cannot steal back, and visible explicit retry can.

## Reopen trigger

Reopen if users accidentally displace one another, if desk control needs first-class ownership, or if a reproducible reconnect can take authority without a direct user action.
