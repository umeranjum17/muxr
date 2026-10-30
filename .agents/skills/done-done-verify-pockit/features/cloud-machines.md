# Cloud machines: retained journey claim set

Journey: `cloud-machines` in `.done-done.yaml`.
Registered capture run: `20261030T072129Z-fdce4519-c91ae5`, captured at
`fdce4519c3e28bd431bd3bdc276096a7033441e0`.

The proof check cites only the distinct original outcome stills below. All
original evidence stays unchanged in the sealed run, including uncited files.
Do not drive or provision another machine to check this retained claim set.

| Claim | Original evidence |
| --- | --- |
| Settings action reaches Boat | `live-05-settings-action.png`, `live-06-boat-entry.png` |
| Create a real cloud machine | `live-06-boat-create-flow.png`, `live-deletion.json` |
| List it with status beside Desk | `live-07-cloud-listed.png` |
| Switch to Desk and back | `live-08-desk-switched.png`, `live-09-cloud-switched-back.png` |
| Reach its shell and read the phone command independently | `live-11-terminal-output.png`, `live-terminal-receipt.json` |
| Forget and delete at the provider | `live-12-cloud-forgotten.png`, `live-deletion.json` |
| Preserve row order during reconnect | `live-reconnect-order.json` |

The redundant `live-reconnect-first.png/.xml`,
`live-reconnect-online.png/.xml` and
`machines-cloud-listed-390-1.0-light.xml` are not citations. Reconnect ordering
is checked from the recorded row names and geometry in
`live-reconnect-order.json`, not from a second identical still. This changes
only the cited claim set, never the duplicate-evidence check or source run.

Use the original evidence directory as `--citation-base`:

```sh
done-done check --from .agents/skills/done-done-verify-pockit/features/cloud-machines.md \
  --claim-id fm/mx-cloud-machine-add1 --citation-base "$CLOUD_EVIDENCE"
```

## Checks
outcome: Settings > Machines can add one real Boat cloud machine beside Desk with status, switch to Desk and back, reach its shell terminal, then forget the cloud machine and delete it at the provider.
repro: done-done verify cloud-machines (registered run 20261030T072129Z-fdce4519-c91ae5; check only now, no new drive)
proof: .agents/skills/done-done-verify-pockit/SKILL.md; registered cloud-machines journey; original captures at fdce4519c3e28bd431bd3bdc276096a7033441e0
screen: native Settings > Machines, Boat setup, Desk Home, cloud Home and cloud shell terminal
evidence: live-05-settings-action.png, live-06-boat-entry.png, live-06-boat-create-flow.png, live-07-cloud-listed.png, live-08-desk-switched.png, live-09-cloud-switched-back.png, live-11-terminal-output.png, live-12-cloud-forgotten.png, live-terminal-receipt.json, live-deletion.json, live-reconnect-order.json
