# Published desktop kit gap

- Owner: `@desklink/host` (published dependency; not patched by this task).
- File/function: `dist/engineProcess.js`, `EngineClient.request` (line 145 in the installed package).
- Cause: `child.stdin.write` has an error callback but the child stdin Socket has no `error` listener. A failed write both calls its callback and emits an `error` event. Rejecting the request Promise does not consume the event; Node terminates with a raw stack before an enclosing async catch can handle it.
- Expected kit behavior: handle the control stream's error event, reject outstanding requests with the real reason, and retain engine ownership/cleanup. The caller must receive a catchable Promise rejection.

## Reproduction

From this checkout (no credentials, real Node child process and real published kit):

```sh
node --input-type=module -e '
import {spawn} from "node:child_process";
import {EngineClient} from "@desklink/host";
const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},100)"],
  {stdio:["pipe","pipe","pipe"]});
const client = new EngineClient(child, {});
child.stdin.end();
try { await client.request("hello", {}); }
catch (error) { console.error("Promise caught:", error.message); }
'
```

Observed: exit 1, `Unhandled 'error' event`, `ERR_STREAM_WRITE_AFTER_END`, and a Node stack despite the async try/catch. The child exits naturally after 100ms. A closed engine pipe can similarly produce an uncaught EPIPE; this reproduction isolates the missing listener without a timing race.

Evidence: `/home/umer/.treehouse/firstmate-8bf1b0/8/firstmate/data/pock-onb-no-crash-after-pair1/evidence/kit-before.log`.

## Muxr boundary decision

A top-level async try/catch in `scripts/cli.mjs` handles rejected setup operations, not this emitted event. Suppressing its raw stack requires a process-level fatal CLI error handler (which must terminate, not resume damaged execution), or the upstream kit fix. Neither a kit patch nor a consumer socket wrapper is authorized. Firstmate must confirm the fatal CLI policy before claiming the uncaught socket case is contained; a generic boundary also cannot truthfully say "Pairing is done" unless it knows pairing already completed.
