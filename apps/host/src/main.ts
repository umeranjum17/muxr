// Handle help before importing the runtime: even module initialization must
// not inspect setup state or start host resources for a help request.
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage: muxr-host [options]

Start the muxr host using setup state and $MUXR_HOME/config.json.

Options:
  --help, -h                Print this help and exit
  --fake                    Use the fake development session source
  --mode <local|selfhost>    Override the host mode
  --relay-url <url>         Override the relay WebSocket URL
  --machine-id <id>         Override the machine identity
  --machine-name <name>     Override the machine display name
  --data-dir <path>         Override the host data directory
  --host-http-port <port>   Override the host HTTP port
  --check-host-stopped      Check that this machine's host is stopped
  --retire-machine-peers    Retire this machine's paired peers
`);
} else if (args[0] === '--muxr-token-ledger') {
    // The usage ledger's child (LedgerProcess): the packaged host is this one
    // bundle, so the child re-enters here and must count, not start a host.
    await import('./usage/infrastructure/tokenLedger.js');
} else {
    await import('./runHost.js');
}

export {};
