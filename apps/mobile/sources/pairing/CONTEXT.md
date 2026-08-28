# Pairing

Binding this device to a machine and the permission that follows.

## Language

**Pairing String**:
The URL a person pastes or scans to bind this device to a machine. Distinct from account login.
_Avoid_: claim, ticket, QR payload

**Hosted Grant**:
The verified machine permission this device stores after pairing. It owns Device Authority, the relay, and the keys used to open sealed traffic.
_Avoid_: token, pairing cache, device record

**Device Authority**:
Control or observe permission stored on the Hosted Grant. Comes from the Pairing String, never from a machine display name.
_Avoid_: role, browser flag

Use cases: Pair Machine / restore Connection / forget Machine — [USE_CASES.md](../USE_CASES.md).
