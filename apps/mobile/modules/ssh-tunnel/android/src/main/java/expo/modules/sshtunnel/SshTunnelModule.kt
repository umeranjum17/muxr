package expo.modules.sshtunnel

import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

/**
 * SSH local port-forward for self-host connections (Android). The app tunnels
 * 127.0.0.1:<localPort> on the phone to <remoteHost>:<remotePort> via the SSH
 * server, then points the relay URL at the local port.
 *
 * Host-key trust is TOFU: connect returns the SHA-256 fingerprint; the app
 * pins it and passes the pinned value on later connects, which are rejected
 * on mismatch.
 */
class SshTunnelModule : Module() {
  private var session: Session? = null

  override fun definition() = ModuleDefinition {
    Name("SshTunnel")

    AsyncFunction("connect") { config: Map<String, Any?>, pinnedFingerprint: String? ->
      val host = config["host"] as? String ?: throw IllegalArgumentException("host required")
      val port = (config["port"] as? Number)?.toInt() ?: 22
      val username = config["username"] as? String ?: throw IllegalArgumentException("username required")
      val password = config["password"] as? String
      val privateKey = config["privateKey"] as? String

      val jsch = JSch()
      if (privateKey != null) jsch.addIdentity("muxr", privateKey.toByteArray(), null, null)
      val next = jsch.getSession(username, host, port)
      if (password != null) next.setPassword(password)
      // Verify the host key DURING key exchange, before any credential is sent.
      // A changed key aborts KEX itself, so a MITM never sees the password.
      val captured = arrayOfNulls<String>(1)
      next.hostKeyRepository = object : com.jcraft.jsch.HostKeyRepository {
        override fun check(host: String, key: ByteArray): Int {
          val digest = MessageDigest.getInstance("SHA-256").digest(key)
          val fingerprint = "SHA256:" + android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP).trimEnd('=')
          captured[0] = fingerprint
          return when {
            pinnedFingerprint == null -> com.jcraft.jsch.HostKeyRepository.OK // first connect: capture
            pinnedFingerprint == fingerprint -> com.jcraft.jsch.HostKeyRepository.OK
            else -> com.jcraft.jsch.HostKeyRepository.CHANGED
          }
        }
        override fun getHostKey() = arrayOfNulls<com.jcraft.jsch.HostKey>(0)
        override fun getHostKey(host: String?, type: String?) = arrayOfNulls<com.jcraft.jsch.HostKey>(0)
        override fun add(hostkey: com.jcraft.jsch.HostKey?, ui: com.jcraft.jsch.UserInfo?) {}
        override fun remove(host: String?, type: String?) {}
        override fun remove(host: String?, type: String?, key: ByteArray?) {}
        override fun getKnownHostsRepositoryID() = "muxr-tofu"
      }
      session?.disconnect()
      next.connect(10_000)
      session = next
      captured[0] ?: throw IllegalStateException("host key not captured")
    }

    AsyncFunction("forwardLocal") { localPort: Int, remoteHost: String, remotePort: Int ->
      val active = session ?: throw IllegalStateException("not connected")
      active.setPortForwardingL("127.0.0.1", localPort, remoteHost, remotePort)
      true
    }

    AsyncFunction("close") {
      session?.disconnect()
      session = null
      true
    }
  }
}
