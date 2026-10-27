# Troubleshooting

## Setup is still waiting

Keep the setup wizard open and follow its visible prompt. Pairing QR codes and claims expire, so generate a new one instead of reusing an old capture.

## The phone shows no machine

Confirm the host and relay are running on the paired computer, then run the pairing flow again. A machine key is never recovered from email or the website.

## Pairing expired

On a Tailscale route, open the link from `muxr link` again; it does not expire. A link that says it no longer works was replaced (a device was revoked): run `muxr link` for the current one. A one-use code from `muxr pair --code` expires after five minutes; run it again.

## Connection is blocked

Confirm the phone can reach the configured relay URL. A revoked device or pending machine-key rotation blocks new tickets; reconnect the host so it can rotate and reseal grants for remaining devices.

## Redacted diagnostics

Run:

```bash
muxr doctor
```

Share only the redacted output. Never share QR payloads, device or machine credentials, SecureStore data, provider keys, or raw muxr state files.
