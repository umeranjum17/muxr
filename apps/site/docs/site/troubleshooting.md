# Troubleshooting

## Setup is still waiting

Keep the setup wizard open and follow its visible prompt. Pairing QR codes and claims expire, so generate a new one instead of reusing an old capture.

## The phone shows no machine

Confirm the host and relay are running on the paired computer, then run the pairing flow again. A machine key is never recovered from email or the website.

## Pairing expired

Run `muxr pair` again. Pair claims are single-use and expire after five minutes.

## Connection is blocked

Confirm the phone can reach the configured relay URL. A revoked device or pending machine-key rotation blocks new tickets; reconnect the host so it can rotate and reseal grants for remaining devices.

## Redacted diagnostics

Run:

```bash
muxr doctor
```

Share only the redacted output. Never share QR payloads, device or machine credentials, SecureStore data, provider keys, or raw muxr state files.
