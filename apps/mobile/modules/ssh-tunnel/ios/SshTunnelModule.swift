import ExpoModulesCore
import Foundation

private struct SshTunnelRecord: Record {
  @Field var host: String = ""
  @Field var port: Int = 22
  @Field var username: String = ""
  @Field var password: String?
  @Field var privateKey: String?
  @Field var passphrase: String?
  @Field var knownHostKey: String?
  @Field var remoteHost: String = "127.0.0.1"
  @Field var remotePort: Int = 8792
  @Field var localPort: Int = 0
  @Field var connectTimeoutMs: Int = 15000

  var configuration: SshConfiguration {
    SshConfiguration(host: host, port: port, username: username, password: password,
                     privateKey: privateKey, passphrase: passphrase, knownHostKey: knownHostKey,
                     remoteHost: remoteHost, remotePort: remotePort, localPort: localPort,
                     timeout: Double(min(120000, max(1000, connectTimeoutMs))) / 1000)
  }
}

private final class SshNativeError: Exception {
  private let failure: SshFailure
  init(_ failure: SshFailure) { self.failure = failure; super.init() }
  override var code: String { failure.code }
  override var reason: String { failure.message }
}

public final class SshTunnelModule: Module {
  private let lock = NSLock()
  private var tunnel: SshTransport?
  private var generation = 0

  public func definition() -> ModuleDefinition {
    Name("SshTunnel")
    AsyncFunction("openTunnel") { (record: SshTunnelRecord) async throws -> [String: Any] in
      try await self.background { try self.open(record.configuration) }
    }
    AsyncFunction("verifyCredentials") { (record: SshTunnelRecord) async throws -> [String: String] in
      try await self.background {
        let connection = try SshTransport(record.configuration)
        defer { connection.close() }
        return ["hostKey": connection.hostKey]
      }
    }
    AsyncFunction("execCommand") { (record: SshTunnelRecord, command: String) async throws -> [String: Any] in
      try await self.background {
        _ = try self.open(record.configuration)
        guard let active = self.lock.withLock({ self.tunnel }), active.alive else {
          throw SshFailure(code: "ssh-unreachable", message: "no SSH connection is open")
        }
        return try active.command(command)
      }
    }
    AsyncFunction("closeTunnel") { await self.backgroundClose() }
    AsyncFunction("openForward") { (remotePort: Int) async throws -> [String: Int] in
      try await self.background {
        guard let active = self.lock.withLock({ self.tunnel }), active.alive else {
          throw SshFailure(code: "ssh-unreachable", message: "no SSH connection is open")
        }
        return ["localPort": try active.openForward(remotePort)]
      }
    }
    AsyncFunction("closeForward") { (localPort: Int) async throws in
      try await self.background { self.lock.withLock { self.tunnel }?.closeForward(localPort) }
    }
    Function("tunnelPort") {
      self.lock.withLock { self.tunnel.flatMap { $0.alive ? $0.localPort : nil } ?? 0 }
    }
    OnDestroy { self.closeCurrent() }
  }

  private func background<T>(_ operation: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        do { continuation.resume(returning: try operation()) }
        catch let failure as SshFailure { continuation.resume(throwing: SshNativeError(failure)) }
        catch { continuation.resume(throwing: SshNativeError(SshFailure(code: "ssh-unreachable", message: "the SSH connection failed"))) }
      }
    }
  }

  private func backgroundClose() async {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        self.closeCurrent()
        continuation.resume()
      }
    }
  }

  private func open(_ config: SshConfiguration) throws -> [String: Any] {
    try config.validate()
    let reused = try lock.withLock { () throws -> [String: Any]? in
      guard let existing = tunnel, existing.alive, existing.signature == config.signature else { return nil }
      if let expected = config.knownHostKey, !expected.isEmpty, expected != existing.hostKey {
        throw SshFailure(code: "ssh-host-key", message: "the SSH host key changed")
      }
      return ["localPort": existing.localPort, "hostKey": existing.hostKey]
    }
    if let reused { return reused }
    let (previous, expected) = lock.withLock { () -> (SshTransport?, Int) in
      let previous = tunnel
      tunnel = nil
      generation += 1
      return (previous, generation)
    }
    previous?.close()
    let opened = try SshTransport(config)
    do { _ = try opened.start(preferredPort: config.localPort, remotePort: config.remotePort) }
    catch { opened.close(); throw error }
    let superseded = lock.withLock { () -> Bool in
      guard expected == generation else { return true }
      tunnel = opened
      return false
    }
    if superseded {
      opened.close()
      throw SshFailure(code: "ssh-unreachable", message: "the SSH connection was closed before it opened")
    }
    return ["localPort": opened.localPort, "hostKey": opened.hostKey]
  }

  private func closeCurrent() {
    let previous = lock.withLock { () -> SshTransport? in
      let previous = tunnel
      tunnel = nil
      generation += 1
      return previous
    }
    previous?.close()
  }
}
