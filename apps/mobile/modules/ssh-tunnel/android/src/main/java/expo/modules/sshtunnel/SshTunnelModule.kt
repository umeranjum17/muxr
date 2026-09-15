package expo.modules.sshtunnel

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.connection.channel.direct.LocalPortForwarder
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.transport.kex.Curve25519SHA256
import net.schmizz.sshj.transport.kex.ECDHNistP
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import com.hierynomus.sshj.key.KeyAlgorithms
import com.hierynomus.sshj.userauth.keyprovider.OpenSSHKeyV1KeyFile
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.keyprovider.FileKeyProvider
import net.schmizz.sshj.userauth.keyprovider.KeyFormat
import net.schmizz.sshj.userauth.keyprovider.KeyProviderUtil
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile
import net.schmizz.sshj.userauth.keyprovider.PuTTYKeyFile
import net.schmizz.sshj.userauth.password.PasswordUtils
import java.io.IOException
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.security.PublicKey

/**
 * SSH is transport only: it carries the ordinary muxr relay socket to a relay
 * that stays on the host's loopback. Pairing, device grants, and end-to-end
 * encryption run inside this tunnel and remain the authority.
 *
 * Nothing here logs, persists, or returns credential or private key material.
 */

private const val LOOPBACK = "127.0.0.1"

class SshUnreachableException(message: String, cause: Throwable?) :
    CodedException("ssh-unreachable", message, cause)

class SshAuthException(message: String, cause: Throwable?) :
    CodedException("ssh-auth", message, cause)

class SshHostKeyException(message: String) : CodedException("ssh-host-key", message, null)

class SshLocalPortException(message: String, cause: Throwable?) :
    CodedException("ssh-local-port", message, cause)

class SshConfigurationException(message: String) :
    CodedException("ssh-configuration", message, null)

class SshTunnelConfig : Record {
    @Field var host: String = ""
    @Field var port: Int = 22
    @Field var username: String = ""
    @Field var password: String? = null
    @Field var privateKey: String? = null
    @Field var passphrase: String? = null

    /** Pinned `SHA256:…` host key. Absent means trust-on-first-use; the caller stores what it gets back. */
    @Field var knownHostKey: String? = null

    /** Relay address as seen from the host, always its loopback. */
    @Field var remoteHost: String = LOOPBACK
    @Field var remotePort: Int = 8792

    /** Preferred device-local port so the advertised relay URL stays literally true. */
    @Field var localPort: Int = 0

    @Field var connectTimeoutMs: Int = 15_000
}

/** True when the failure is the known Ed25519 gap, which deserves its own guidance. */
private fun isEd25519Failure(cause: Exception): Boolean {
    var current: Throwable? = cause
    while (current != null) {
        if (current.message?.contains("Ed25519", ignoreCase = true) == true) return true
        current = current.cause
    }
    return false
}

/** Non-secret identity of a tunnel, used to decide whether an open one can be reused. */
private fun signatureOf(config: SshTunnelConfig): String =
    "${config.username}@${config.host}:${config.port}->${config.remoteHost}:${config.remotePort}"

private fun fingerprintOf(key: PublicKey): String {
    val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
    val digest = MessageDigest.getInstance("SHA-256").digest(blob)
    return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
}

private class PinnedHostKeyVerifier(private val expected: String?) : HostKeyVerifier {
    @Volatile
    var observed: String? = null
        private set

    override fun verify(hostname: String?, port: Int, key: PublicKey?): Boolean {
        if (key == null) return false
        val actual = fingerprintOf(key)
        observed = actual
        val pinned = expected
        if (pinned.isNullOrBlank()) return true
        return MessageDigest.isEqual(pinned.toByteArray(), actual.toByteArray())
    }

    override fun findExistingAlgorithms(hostname: String?, port: Int): MutableList<String> = mutableListOf()
}

private class Tunnel(
    val signature: String,
    val client: SSHClient,
    val server: ServerSocket,
    val localPort: Int,
    val hostKey: String,
) {
    @Volatile
    var forwarder: Thread? = null

    fun alive(): Boolean = client.isConnected && client.isAuthenticated && !server.isClosed

    fun close() {
        try { server.close() } catch (_: IOException) {}
        try { client.disconnect() } catch (_: IOException) {}
    }
}

class SshTunnelModule : Module() {
    private val lock = Any()
    private var tunnel: Tunnel? = null
    private var generation = 0

    override fun definition() = ModuleDefinition {
        Name("SshTunnel")

        AsyncFunction("openTunnel") { config: SshTunnelConfig -> open(config) }

        AsyncFunction("closeTunnel") { closeCurrent() }

        Function("tunnelPort") {
            synchronized(lock) { tunnel?.takeIf { it.alive() }?.localPort ?: 0 }
        }

        OnDestroy { closeCurrent() }
    }

    private fun closeCurrent() {
        synchronized(lock) {
            tunnel?.close()
            tunnel = null
            generation += 1
        }
    }

    private fun open(config: SshTunnelConfig): Map<String, Any> {
        validate(config)
        val expected = synchronized(lock) {
            val existing = tunnel
            if (existing != null && existing.alive() && existing.signature == signatureOf(config)) {
                return mapOf("localPort" to existing.localPort, "hostKey" to existing.hostKey)
            }
            existing?.close()
            tunnel = null
            generation += 1
            generation
        }
        val opened = connect(config)
        val superseded = synchronized(lock) {
            if (expected != generation) {
                true
            } else {
                tunnel?.close()
                tunnel = opened
                false
            }
        }
        if (superseded) {
            opened.close()
            throw SshUnreachableException("the SSH connection was closed before it opened", null)
        }
        return mapOf("localPort" to opened.localPort, "hostKey" to opened.hostKey)
    }

    private fun validate(config: SshTunnelConfig) {
        if (config.host.isBlank() || config.username.isBlank()) {
            throw SshConfigurationException("SSH host and username are required")
        }
        if (config.port !in 1..65535 || config.remotePort !in 1..65535 || config.localPort !in 0..65535) {
            throw SshConfigurationException("SSH ports are out of range")
        }
        if (config.remoteHost != LOOPBACK) {
            throw SshConfigurationException("SSH forwarding is limited to the host loopback")
        }
    }

    private fun connect(config: SshTunnelConfig): Tunnel {
        // SSHJ looks its algorithms up under one JCA provider name. Android's
        // built-in "BC" provider cannot do X25519, EC, or Ed25519 key
        // agreement and signatures, and the bundled Bouncy Castle jar loses
        // the "BC" name to the platform copy, so the SSHJ defaults fail on
        // every device even though negotiation succeeds. Conscrypt implements
        // everything this tunnel needs except Ed25519, so point SSHJ at it
        // and stop offering Ed25519 host and login keys: servers fall back to
        // the RSA/ECDSA keys they already carry by default, and an
        // Ed25519-only setup fails below with an actionable message instead
        // of a generic unreachable error.
        SecurityUtils.setSecurityProvider("AndroidOpenSSL")
        val defaults = DefaultConfig()
        defaults.keyExchangeFactories = listOf(
            Curve25519SHA256.Factory(),
            ECDHNistP.Factory256(),
            ECDHNistP.Factory384(),
            ECDHNistP.Factory521(),
        )
        defaults.keyAlgorithms = listOf(
            KeyAlgorithms.RSASHA256(),
            KeyAlgorithms.RSASHA512(),
            KeyAlgorithms.ECDSASHANistp256(),
            KeyAlgorithms.ECDSASHANistp384(),
            KeyAlgorithms.ECDSASHANistp521(),
        )
        // Without keepalives a dropped network leaves the forwarder waiting on a
        // socket that will never answer, which the caller can only show as a spinner.
        defaults.keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
        val client = SSHClient(defaults)
        val verifier = PinnedHostKeyVerifier(config.knownHostKey)
        client.addHostKeyVerifier(verifier)
        client.connectTimeout = config.connectTimeoutMs
        client.timeout = config.connectTimeoutMs
        try {
            client.connect(config.host, config.port)
        } catch (cause: Exception) {
            try { client.disconnect() } catch (_: IOException) {}
            if (verifier.observed != null && config.knownHostKey != null) {
                throw SshHostKeyException("host key changed for ${config.host}")
            }
            if (isEd25519Failure(cause)) {
                throw SshUnreachableException(
                    "this route needs RSA or ECDSA SSH keys: the server only offered Ed25519, which this build does not support yet",
                    cause,
                )
            }
            throw SshUnreachableException("could not reach the SSH host", null)
        }
        client.connection.keepAlive.keepAliveInterval = 15
        try {
            authenticate(client, config)
        } catch (cause: UserAuthException) {
            try { client.disconnect() } catch (_: IOException) {}
            throw SshAuthException("the SSH server rejected these credentials", null)
        } catch (cause: Exception) {
            try { client.disconnect() } catch (_: IOException) {}
            throw SshUnreachableException("the SSH connection failed during sign-in", null)
        }
        val hostKey = verifier.observed
            ?: run {
                try { client.disconnect() } catch (_: IOException) {}
                throw SshHostKeyException("the server did not present a host key")
            }
        val server = bindLocal(config.localPort) { client.disconnect() }
        val tunnel = Tunnel(signatureOf(config), client, server, server.localPort, hostKey)
        // Never turn this into a general SSH port forward: muxr's relay is
        // intentionally reachable only from the SSH host's loopback.
        val parameters = Parameters(LOOPBACK, server.localPort, LOOPBACK, config.remotePort)
        val forwarder: LocalPortForwarder = try {
            client.newLocalPortForwarder(parameters, server)
        } catch (cause: Exception) {
            tunnel.close()
            throw SshLocalPortException("could not start the local SSH forward", cause)
        }
        val thread = Thread({
            try { forwarder.listen() } catch (_: Exception) {} finally { tunnel.close() }
        }, "muxr-ssh-tunnel")
        thread.isDaemon = true
        tunnel.forwarder = thread
        thread.start()
        return tunnel
    }

    private fun authenticate(client: SSHClient, config: SshTunnelConfig) {
        val key = config.privateKey
        if (!key.isNullOrBlank()) {
            if (key.contains("ssh-ed25519")) {
                throw UserAuthException("Ed25519 login keys are not supported yet; use an RSA or ECDSA key")
            }
            val passphrase = config.passphrase
            try {
                val passwordFinder = if (passphrase.isNullOrEmpty()) {
                    null
                } else {
                    PasswordUtils.createOneOff(passphrase.toCharArray())
                }
                val provider: FileKeyProvider = when (KeyProviderUtil.detectKeyFileFormat(key, false)) {
                    KeyFormat.OpenSSHv1 -> OpenSSHKeyV1KeyFile()
                    KeyFormat.OpenSSH -> OpenSSHKeyFile()
                    KeyFormat.PKCS8 -> PKCS8KeyFile()
                    KeyFormat.PuTTY -> PuTTYKeyFile()
                    KeyFormat.Unknown -> throw IOException("unsupported private-key format")
                }
                provider.init(key, null, passwordFinder)
                client.authPublickey(config.username, provider)
            } catch (_: IOException) {
                throw UserAuthException("the private key could not be read")
            }
            return
        }
        val password = config.password
        if (!password.isNullOrEmpty()) {
            client.authPassword(config.username, password)
            return
        }
        throw UserAuthException("no SSH key or password was provided")
    }

    private fun bindLocal(preferred: Int, onFailure: () -> Unit): ServerSocket {
        val loopback = InetAddress.getByName(LOOPBACK)
        if (preferred > 0) {
            try {
                return ServerSocket().apply { bind(InetSocketAddress(loopback, preferred), 16) }
            } catch (_: BindException) {
                // Another app holds it; an ephemeral port works because the caller
                // dials the port this returns rather than assuming one.
            } catch (cause: IOException) {
                onFailure()
                throw SshLocalPortException(cause.message ?: "could not open a local port", cause)
            }
        }
        try {
            return ServerSocket().apply { bind(InetSocketAddress(loopback, 0), 16) }
        } catch (cause: IOException) {
            onFailure()
            throw SshLocalPortException(cause.message ?: "could not open a local port", cause)
        }
    }
}
