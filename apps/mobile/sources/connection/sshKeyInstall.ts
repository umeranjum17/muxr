import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { SshTarget } from './connectionSettings';
import type { SshPublicKeyInfo } from './sshPublicKey';

const RECEIPT_PREFIX = 'muxr.ssh.install.v1.';
export const ALLOWED_ALGORITHMS = new Set([
    'ssh-rsa',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
]);

export interface SshInstallReceipt {
    version: 1;
    machineId: string;
    host: string;
    port: number;
    username: string;
    relayPort: number;
    hostKey: string;
    fingerprint: string;
    operationId: string;
    beforeHash: string;
    beforeMode: string;
    afterHash: string;
    afterMode: string;
    hadFile: boolean;
    createdSshDir: boolean;
}

export type SshInstallResult =
    | { status: 'installed'; receipt: SshInstallReceipt }
    | { status: 'duplicate'; afterHash: string; afterMode: string };

export function sameSshTarget(left: SshTarget | undefined, right: SshTarget | undefined): boolean {
    return left !== undefined && right !== undefined
        && left.host === right.host
        && left.port === right.port
        && left.username === right.username
        && left.relayPort === right.relayPort
        && left.hostKey === right.hostKey;
}

function receiptKey(machineId: string): string {
    return `${RECEIPT_PREFIX}${machineId}`;
}

function validHash(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validMode(value: unknown): value is string {
    return typeof value === 'string' && /^[0-7]{3,4}$/.test(value);
}

function validTarget(value: unknown): value is SshTarget {
    if (typeof value !== 'object' || value === null) return false;
    const target = value as Partial<SshTarget>;
    const port = target.port;
    const relayPort = target.relayPort;
    const hostKey = target.hostKey;
    return typeof target.host === 'string' && target.host.length > 0
        && typeof target.username === 'string' && /^[A-Za-z_][A-Za-z0-9._-]*$/.test(target.username)
        && typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
        && typeof relayPort === 'number' && Number.isInteger(relayPort) && relayPort >= 1 && relayPort <= 65535
        && typeof hostKey === 'string' && /^SHA256:[A-Za-z0-9+/]+$/.test(hostKey);
}

function parseReceipt(raw: string): SshInstallReceipt | undefined {
    try {
        const parsed = JSON.parse(raw) as Partial<SshInstallReceipt> & { target?: unknown };
        const target = parsed.target;
        if (parsed.version !== 1 || typeof parsed.machineId !== 'string' || parsed.machineId.length === 0
            || typeof parsed.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]+$/.test(parsed.fingerprint)
            || typeof parsed.operationId !== 'string' || !/^\d+-\d+$/.test(parsed.operationId)
            || typeof parsed.beforeHash !== 'string' || (parsed.beforeHash !== '' && !validHash(parsed.beforeHash))
            || !validHash(parsed.afterHash)
            || typeof parsed.beforeMode !== 'string' || (parsed.beforeMode !== '' && !validMode(parsed.beforeMode))
            || !validMode(parsed.afterMode)
            || typeof parsed.hadFile !== 'boolean' || typeof parsed.createdSshDir !== 'boolean'
            || (parsed.hadFile === true && (!validHash(parsed.beforeHash) || !validMode(parsed.beforeMode)))
            || !validTarget(target)) return undefined;
        const savedTarget = target as SshTarget;
        return {
            version: 1,
            machineId: parsed.machineId as string,
            host: savedTarget.host,
            port: savedTarget.port,
            username: savedTarget.username,
            relayPort: savedTarget.relayPort,
            hostKey: savedTarget.hostKey as string,
            fingerprint: parsed.fingerprint as string,
            operationId: parsed.operationId as string,
            beforeHash: parsed.beforeHash as string,
            beforeMode: parsed.beforeMode as string,
            afterHash: parsed.afterHash as string,
            afterMode: parsed.afterMode as string,
            hadFile: parsed.hadFile as boolean,
            createdSshDir: parsed.createdSshDir as boolean,
        };
    } catch {
        return undefined;
    }
}

export async function loadSshInstallReceipt(machineId: string): Promise<SshInstallReceipt | undefined> {
    if (machineId === '') return undefined;
    const { getNativeSecret } = await import('@/pairing/secrets');
    const raw = await getNativeSecret(receiptKey(machineId));
    return raw === null ? undefined : parseReceipt(raw);
}

export async function saveSshInstallReceipt(receipt: SshInstallReceipt): Promise<void> {
    const { setNativeSecret } = await import('@/pairing/secrets');
    await setNativeSecret(receiptKey(receipt.machineId), JSON.stringify({
        version: receipt.version,
        machineId: receipt.machineId,
        target: {
            host: receipt.host,
            port: receipt.port,
            username: receipt.username,
            relayPort: receipt.relayPort,
            hostKey: receipt.hostKey,
        },
        fingerprint: receipt.fingerprint,
        operationId: receipt.operationId,
        beforeHash: receipt.beforeHash,
        beforeMode: receipt.beforeMode,
        afterHash: receipt.afterHash,
        afterMode: receipt.afterMode,
        hadFile: receipt.hadFile,
        createdSshDir: receipt.createdSshDir,
    }));
}

export async function clearSshInstallReceipt(machineId: string): Promise<void> {
    if (machineId === '') return;
    const { deleteNativeSecret } = await import('@/pairing/secrets');
    await deleteNativeSecret(receiptKey(machineId));
}

function shellQuote(value: string): string {
    if (/\0|[\r\n]/.test(value)) throw new Error('SSH command value contains a line break');
    return `'${value.replaceAll("'", "'\\''")}'`;
}

interface ValidPublicKey {
    algorithm: string;
    blob: string;
    publicKey: string;
    fingerprint: string;
}

function validatePublicKey(info: SshPublicKeyInfo): ValidPublicKey {
    const match = /^(ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ([A-Za-z0-9+/]+={0,2})$/.exec(info.publicKey);
    if (match === null || match[1] !== info.algorithm || !ALLOWED_ALGORITHMS.has(info.algorithm)) {
        throw new Error('This public key format is not supported for installation. Use an RSA or ECDSA key.');
    }
    try {
        const bytes = decodeBase64(match[2]);
        if (bytes.length === 0 || encodeBase64(bytes) !== match[2]) throw new Error('non-canonical key');
    } catch {
        throw new Error('The public key is malformed. Copy or save it instead.');
    }
    if (!/^SHA256:[A-Za-z0-9+/]+$/.test(info.fingerprint)) throw new Error('The key fingerprint is invalid.');
    return { algorithm: match[1], blob: match[2], publicKey: info.publicKey, fingerprint: info.fingerprint };
}

function validateUsername(username: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(username)) throw new Error('This SSH account name is not supported for installation. Copy the public key instead.');
}

function scriptCommand(lines: string[], marker: string): string {
    return `sh -eu <<'${marker}'\n${lines.join('\n')}\n${marker}`;
}

/** Exact command sent over the pinned SSH connection after the user confirms. */
export function buildSshInstallCommand(info: SshPublicKeyInfo, username: string): string {
    const key = validatePublicKey(info);
    validateUsername(username);
    return scriptCommand([
        'set -eu',
        `EXPECTED_USER=${shellQuote(username)}`,
        `KEY_ALGORITHM=${shellQuote(key.algorithm)}`,
        `KEY_BLOB=${shellQuote(key.blob)}`,
        `PUBLIC_KEY=${shellQuote(key.publicKey)}`,
        'fail() { printf \'MUXR_INSTALL_ERROR:%s\\n\' "$1" >&2; exit 1; }',
        'command -v sha256sum >/dev/null 2>&1 || fail missing-sha256sum',
        'command -v stat >/dev/null 2>&1 || fail missing-stat',
        'self_user="$(id -un 2>/dev/null)" || fail account-unavailable',
        '[ "$self_user" = "$EXPECTED_USER" ] || fail target-account-mismatch',
        'self_uid="$(id -u 2>/dev/null)" || fail account-unavailable',
        'home=""',
        'if command -v getent >/dev/null 2>&1; then home="$(getent passwd "$self_uid" 2>/dev/null | awk -F: \'NR == 1 {print $6}\')" || home=""; fi',
        '[ -n "$home" ] || home="${HOME:-}"',
        '[ -n "$home" ] || fail home-unavailable',
        'case "$home" in /*) ;; *) fail unsafe-home ;; esac',
        '[ ! -L "$home" ] || fail unsafe-home',
        'home="$(CDPATH= cd -P "$home" 2>/dev/null && pwd -P)" || fail unsafe-home',
        'home_uid="$(stat -c "%u" "$home" 2>/dev/null)" || fail unsafe-home',
        '[ "$home_uid" = "$self_uid" ] || fail unsafe-home-owner',
        'ssh_dir="$home/.ssh"',
        'created_dir=0',
        '[ ! -L "$ssh_dir" ] || fail unsafe-ssh-dir',
        'if [ -e "$ssh_dir" ]; then',
        '  [ -d "$ssh_dir" ] || fail unsafe-ssh-dir',
        '  [ "$(stat -c "%u" "$ssh_dir" 2>/dev/null)" = "$self_uid" ] || fail unsafe-ssh-dir-owner',
        '  ssh_mode="$(stat -c "%a" "$ssh_dir" 2>/dev/null)" || fail unsafe-ssh-dir',
        '  ssh_mode_value=$((0$ssh_mode))',
        '  [ $((ssh_mode_value & 0022)) -eq 0 ] || fail unsafe-ssh-dir-permissions',
        'else',
        '  mkdir "$ssh_dir" || fail create-ssh-dir',
        '  chmod 700 "$ssh_dir" || fail create-ssh-dir',
        '  created_dir=1',
        'fi',
        'authorized="$ssh_dir/authorized_keys"',
        'lock="$ssh_dir/.muxr-authorized-keys.lock"',
        'op="$(date +%s)-$$" || fail operation-id',
        'had_file=0',

        'committed=0',
        'lock_owned=0',
        'before_hash=""',
        'before_mode=""',
        'after_hash=""',
        'after_mode=""',
        'backup=""',
        'tmp=""',
        'cleanup() {',
        '  status=$?',
        '  trap - EXIT',
        '  if [ "$status" -ne 0 ] && [ "$committed" -eq 1 ]; then',
        '    if [ "$had_file" -eq 1 ] && [ -n "$backup" ] && [ -f "$backup" ] && [ ! -L "$backup" ]; then',
        '      mv -f "$backup" "$authorized" 2>/dev/null || true',
        '      chmod "$before_mode" "$authorized" 2>/dev/null || true',
        '      command -v restorecon >/dev/null 2>&1 && restorecon "$authorized" 2>/dev/null || true',
        '    elif [ "$had_file" -eq 0 ]; then',
        '      rm -f "$authorized" 2>/dev/null || true',
        '    fi',
        '  fi',
        '  if [ "$status" -ne 0 ] && [ "$committed" -eq 0 ] && [ -n "$backup" ]; then rm -f "$backup" 2>/dev/null || true; fi',
        '  if [ -n "$tmp" ]; then rm -f "$tmp" 2>/dev/null || true; fi',
        '  if [ "$lock_owned" -eq 1 ]; then rmdir "$lock" 2>/dev/null || true; fi',
        '  if [ "$status" -ne 0 ] && [ "$created_dir" -eq 1 ]; then rmdir "$ssh_dir" 2>/dev/null || true; fi',
        '  exit "$status"',
        '}',
        'trap cleanup EXIT',
        'trap \'exit 143\' HUP INT TERM',
        'key_present() { awk -v algorithm="$KEY_ALGORITHM" -v blob="$KEY_BLOB" \'{ for (i = 1; i < NF; i += 1) if ($i == algorithm && $(i + 1) == blob) found = 1 } END { exit(found ? 0 : 1) }\' "$1"; }',
        'attempt=0',
        'while ! mkdir "$lock" 2>/dev/null; do attempt=$((attempt + 1)); [ "$attempt" -lt 50 ] || fail lock-busy; sleep 0.1; done',
        'lock_owned=1',
        '[ ! -L "$authorized" ] || fail unsafe-authorized-keys',
        'if [ -e "$authorized" ]; then',
        '  [ -f "$authorized" ] || fail unsafe-authorized-keys',
        '  [ "$(stat -c "%u" "$authorized" 2>/dev/null)" = "$self_uid" ] || fail unsafe-authorized-keys-owner',
        '  file_mode="$(stat -c "%a" "$authorized" 2>/dev/null)" || fail unsafe-authorized-keys',
        '  file_mode_value=$((0$file_mode))',
        '  [ $((file_mode_value & 0022)) -eq 0 ] || fail unsafe-authorized-keys-permissions',
        '  if key_present "$authorized"; then',
        '    after_hash="$(sha256sum "$authorized" | awk \'{print $1}\')" || fail read-authorized-keys',
        '    after_mode="$file_mode"',
        '    printf \'MUXR_SSH_INSTALL_DUPLICATE\\t%s\\t%s\\n\' "$after_hash" "$after_mode"',
        '    exit 0',
        '  fi',
        '  had_file=1',
        '  before_hash="$(sha256sum "$authorized" | awk \'{print $1}\')" || fail read-authorized-keys',
        '  before_mode="$file_mode"',
        '  backup="$ssh_dir/.authorized_keys.muxr.$op.bak"',
        '  (umask 077; set -C; : > "$backup") || fail backup-exists',
        '  cp "$authorized" "$backup" || fail backup-failed',
        '  chmod 600 "$backup" || fail backup-failed',
        'else',
        '  :',
        'fi',
        'tmp="$ssh_dir/.authorized_keys.muxr.$op.tmp"',
        '(umask 077; set -C; : > "$tmp") || fail temp-exists',
        'if [ "$had_file" -eq 1 ]; then',
        '  cat "$authorized" > "$tmp" || fail temp-write',
        '  if [ -s "$authorized" ]; then last_byte="$(tail -c 1 "$authorized" | od -An -t x1 | tr -d \' \\n\')"; [ "$last_byte" = 0a ] || printf \'\\n\' >> "$tmp"; fi',
        'fi',
        'printf \'%s\\n\' "$PUBLIC_KEY" >> "$tmp" || fail temp-write',
        'if [ "$had_file" -eq 1 ]; then',
        '  [ "$(sha256sum "$authorized" | awk \'{print $1}\')" = "$before_hash" ] || fail changed-before-commit',
        '  [ "$(stat -c "%a" "$authorized" 2>/dev/null)" = "$before_mode" ] || fail permissions-changed-before-commit',
        'else',
        '  [ ! -e "$authorized" ] && [ ! -L "$authorized" ] || fail changed-before-commit',
        'fi',
        'chmod "${before_mode:-600}" "$tmp" || fail temp-permissions',
        'mv -f "$tmp" "$authorized" || fail commit-failed',
        'tmp=""',
        'committed=1',
        'command -v restorecon >/dev/null 2>&1 && restorecon "$authorized" 2>/dev/null || true',
        '[ -f "$authorized" ] && [ ! -L "$authorized" ] || fail verify-authorized-keys',
        '[ "$(stat -c "%u" "$authorized" 2>/dev/null)" = "$self_uid" ] || fail verify-authorized-keys-owner',
        'after_mode="$(stat -c "%a" "$authorized" 2>/dev/null)" || fail verify-authorized-keys',
        'after_hash="$(sha256sum "$authorized" | awk \'{print $1}\')" || fail verify-authorized-keys',
        '[ "$after_mode" = "${before_mode:-600}" ] || fail verify-authorized-keys-permissions',
        'key_present "$authorized" || fail verify-key',
        'printf \'MUXR_SSH_INSTALL_OK\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$op" "$before_hash" "$before_mode" "$after_hash" "$after_mode" "$had_file" "$created_dir"',
        'exit 0',
    ], 'MUXR_SSH_INSTALL');
}

/** Exact guarded rollback command. It restores only the untouched postimage. */
export function buildSshRollbackCommand(receipt: SshInstallReceipt): string {
    if (!/^\d+-\d+$/.test(receipt.operationId) || !validHash(receipt.afterHash) || !validMode(receipt.afterMode)
        || (receipt.hadFile && !validMode(receipt.beforeMode))) {
        throw new Error('The saved SSH install receipt is invalid. Copy the public key instead.');
    }
    validateUsername(receipt.username);
    return scriptCommand([
        'set -eu',
        `EXPECTED_USER=${shellQuote(receipt.username)}`,
        `OPERATION_ID=${shellQuote(receipt.operationId)}`,
        `EXPECTED_POST_HASH=${shellQuote(receipt.afterHash)}`,
        `EXPECTED_POST_MODE=${shellQuote(receipt.afterMode)}`,
        `BEFORE_MODE=${shellQuote(receipt.beforeMode)}`,
        `HAD_FILE=${shellQuote(receipt.hadFile ? '1' : '0')}`,
        `CREATED_DIR=${shellQuote(receipt.createdSshDir ? '1' : '0')}`,
        'fail() { printf \'MUXR_ROLLBACK_ERROR:%s\\n\' "$1" >&2; exit 1; }',
        'command -v sha256sum >/dev/null 2>&1 || fail missing-sha256sum',
        'command -v stat >/dev/null 2>&1 || fail missing-stat',
        'self_user="$(id -un 2>/dev/null)" || fail account-unavailable',
        '[ "$self_user" = "$EXPECTED_USER" ] || fail target-account-mismatch',
        'self_uid="$(id -u 2>/dev/null)" || fail account-unavailable',
        'home=""',
        'if command -v getent >/dev/null 2>&1; then home="$(getent passwd "$self_uid" 2>/dev/null | awk -F: \'NR == 1 {print $6}\')" || home=""; fi',
        '[ -n "$home" ] || home="${HOME:-}"',
        '[ -n "$home" ] || fail home-unavailable',
        'case "$home" in /*) ;; *) fail unsafe-home ;; esac',
        '[ ! -L "$home" ] || fail unsafe-home',
        'home="$(CDPATH= cd -P "$home" 2>/dev/null && pwd -P)" || fail unsafe-home',
        '[ "$(stat -c "%u" "$home" 2>/dev/null)" = "$self_uid" ] || fail unsafe-home-owner',
        'ssh_dir="$home/.ssh"',
        'authorized="$ssh_dir/authorized_keys"',
        'backup="$ssh_dir/.authorized_keys.muxr.$OPERATION_ID.bak"',
        'lock="$ssh_dir/.muxr-authorized-keys.lock"',
        '[ -d "$ssh_dir" ] && [ ! -L "$ssh_dir" ] || fail unsafe-ssh-dir',
        '[ "$(stat -c "%u" "$ssh_dir" 2>/dev/null)" = "$self_uid" ] || fail unsafe-ssh-dir-owner',
        'lock_owned=0',
        'cleanup() { status=$?; trap - EXIT; if [ "$lock_owned" -eq 1 ]; then rmdir "$lock" 2>/dev/null || true; fi; exit "$status"; }',
        'trap cleanup EXIT',
        'trap \'exit 143\' HUP INT TERM',
        'attempt=0',
        'while ! mkdir "$lock" 2>/dev/null; do attempt=$((attempt + 1)); [ "$attempt" -lt 50 ] || fail lock-busy; sleep 0.1; done',
        'lock_owned=1',
        '[ -f "$authorized" ] && [ ! -L "$authorized" ] || fail changed-after-install',
        '[ "$(stat -c "%u" "$authorized" 2>/dev/null)" = "$self_uid" ] || fail changed-after-install',
        '[ "$(stat -c "%a" "$authorized" 2>/dev/null)" = "$EXPECTED_POST_MODE" ] || fail changed-after-install',
        '[ "$(sha256sum "$authorized" | awk \'{print $1}\')" = "$EXPECTED_POST_HASH" ] || fail changed-after-install',
        'if [ "$HAD_FILE" = 1 ]; then',
        '  [ -f "$backup" ] && [ ! -L "$backup" ] || fail backup-missing',
        '  [ "$(stat -c "%u" "$backup" 2>/dev/null)" = "$self_uid" ] || fail backup-unsafe',
        '  [ "$(stat -c "%a" "$backup" 2>/dev/null)" = 600 ] || fail backup-unsafe',
        '  mv -f "$backup" "$authorized" || fail rollback-failed',
        '  chmod "$BEFORE_MODE" "$authorized" || fail rollback-failed',
        '  command -v restorecon >/dev/null 2>&1 && restorecon "$authorized" 2>/dev/null || true',
        'else',
        '  rm -f "$authorized" || fail rollback-failed',
        '  if [ "$CREATED_DIR" = 1 ]; then',
        '    rmdir "$lock" || fail rollback-failed',
        '    lock_owned=0',
        '    rmdir "$ssh_dir" 2>/dev/null || true',
        '  fi',
        'fi',
        'printf \'MUXR_SSH_ROLLBACK_OK\\n\'',
        'exit 0',
    ], 'MUXR_SSH_ROLLBACK');
}

function safeFailureReason(stderr: string, prefix: string): string | undefined {
    const match = new RegExp(`${prefix}([a-z0-9-]+)`).exec(stderr);
    return match?.[1];
}

const installFailureCopy: Record<string, string> = {
    'target-account-mismatch': 'The paired host account is different from the SSH account. Nothing changed; copy the public key instead.',
    'unsafe-authorized-keys': 'The host refused an unsafe authorized_keys path. Nothing changed; inspect it on the host or copy the public key instead.',
    'unsafe-authorized-keys-owner': 'The host account does not own authorized_keys. Nothing changed; copy the public key instead.',
    'unsafe-authorized-keys-permissions': 'authorized_keys has unsafe permissions. Nothing changed; fix its permissions on the host or copy the public key instead.',
    'unsafe-ssh-dir': 'The host refused an unsafe .ssh path. Nothing changed; copy the public key instead.',
    'unsafe-ssh-dir-owner': 'The host account does not own .ssh. Nothing changed; copy the public key instead.',
    'unsafe-ssh-dir-permissions': '.ssh has unsafe permissions. Nothing changed; fix its permissions on the host or copy the public key instead.',
    'changed-before-commit': 'authorized_keys changed while preparing the install. Nothing was installed; inspect it before trying again.',
    'permissions-changed-before-commit': 'authorized_keys permissions changed while preparing the install. Nothing was installed.',
    'lock-busy': 'Another authorized_keys change is in progress. Nothing changed; try again after it finishes.',
    'verify-key': 'The host could not verify the installed key. The operation was rolled back if possible; inspect before retrying.',
};

export function describeSshInstallFailure(stderr: string, exitCode: number): string {
    const reason = safeFailureReason(stderr, 'MUXR_INSTALL_ERROR:');
    return (reason === undefined ? undefined : installFailureCopy[reason])
        ?? (exitCode === 0 ? 'The host did not return an installation receipt.' : 'The host refused the public-key install. Nothing was reported as successful.');
}

export function parseSshInstallResult(result: { stdout: string; stderr: string; exitCode: number }, target: SshTarget, machineId: string, fingerprint: string): SshInstallResult {
    if (result.exitCode !== 0) throw new Error(describeSshInstallFailure(result.stderr, result.exitCode));
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
    const fields = line.split('\t');
    if (fields[0] === 'MUXR_SSH_INSTALL_DUPLICATE' && fields.length === 3 && validHash(fields[1]) && validMode(fields[2])) {
        return { status: 'duplicate', afterHash: fields[1], afterMode: fields[2] };
    }
    if (fields[0] !== 'MUXR_SSH_INSTALL_OK' || fields.length !== 8) {
        throw new Error(describeSshInstallFailure(result.stderr, result.exitCode));
    }
    const [, operationId, beforeHash, beforeMode, afterHash, afterMode, hadFile, createdSshDir] = fields;
    if (!/^\d+-\d+$/.test(operationId) || typeof beforeHash !== 'string'
        || (beforeHash !== '' && !validHash(beforeHash)) || typeof beforeMode !== 'string'
        || (beforeMode !== '' && !validMode(beforeMode)) || !validHash(afterHash) || !validMode(afterMode)
        || !['0', '1'].includes(hadFile) || !['0', '1'].includes(createdSshDir)
        || (hadFile === '1' && (!validHash(beforeHash) || !validMode(beforeMode))) || target.hostKey === undefined) {
        throw new Error('The host returned an invalid installation receipt. Do not retry blindly; inspect authorized_keys on the host.');
    }
    return {
        status: 'installed',
        receipt: {
            version: 1,
            machineId,
            host: target.host,
            port: target.port,
            username: target.username,
            relayPort: target.relayPort,
            hostKey: target.hostKey,
            fingerprint,
            operationId,
            beforeHash,
            beforeMode,
            afterHash,
            afterMode,
            hadFile: hadFile === '1',
            createdSshDir: createdSshDir === '1',
        },
    };
}

export function parseSshRollbackResult(result: { stdout: string; stderr: string; exitCode: number }): void {
    if (result.exitCode === 0 && result.stdout.trim().split(/\r?\n/).some((line) => line === 'MUXR_SSH_ROLLBACK_OK')) return;
    const reason = safeFailureReason(result.stderr, 'MUXR_ROLLBACK_ERROR:');
    if (reason === 'changed-after-install') throw new Error('authorized_keys changed after installation, so rollback refused to overwrite newer edits.');
    throw new Error('Rollback was not confirmed. Inspect authorized_keys on the host before trying again.');
}
