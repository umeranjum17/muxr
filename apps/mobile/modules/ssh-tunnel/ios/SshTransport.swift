import Foundation
import CryptoKit
import Darwin
import MuxrSSH2

struct SshFailure: Error {
  let code: String
  let message: String
}

struct SshConfiguration {
  var host: String
  var port: Int
  var username: String
  var password: String?
  var privateKey: String?
  var passphrase: String?
  var knownHostKey: String?
  var remoteHost: String
  var remotePort: Int
  var localPort: Int
  var timeout: TimeInterval = 15

  var signature: String { "\(username)@\(host):\(port)->\(remoteHost):\(remotePort)" }

  func validate() throws {
    guard !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw SshFailure(code: "ssh-configuration", message: "SSH host and username are required")
    }
    guard (1...65535).contains(port), (1...65535).contains(remotePort), (0...65535).contains(localPort) else {
      throw SshFailure(code: "ssh-configuration", message: "SSH ports are out of range")
    }
    guard remoteHost == "127.0.0.1" else {
      throw SshFailure(code: "ssh-configuration", message: "SSH forwarding is limited to the host loopback")
    }
  }
}

private func nonblocking(_ fd: Int32) {
  _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
  var enabled: Int32 = 1
  _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
}

private func dial(_ config: SshConfiguration) throws -> Int32 {
  var hints = addrinfo()
  hints.ai_socktype = SOCK_STREAM
  var addresses: UnsafeMutablePointer<addrinfo>?
  guard getaddrinfo(config.host, String(config.port), &hints, &addresses) == 0 else {
    throw SshFailure(code: "ssh-unreachable", message: "could not reach the SSH host")
  }
  defer { freeaddrinfo(addresses) }
  let deadline = Date().addingTimeInterval(config.timeout)
  var next = addresses
  while let address = next {
    next = address.pointee.ai_next
    let fd = socket(address.pointee.ai_family, SOCK_STREAM, 0)
    guard fd >= 0 else { continue }
    nonblocking(fd)
    let result = Darwin.connect(fd, address.pointee.ai_addr, address.pointee.ai_addrlen)
    if result == 0 { return fd }
    if errno == EINPROGRESS {
      var event = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      let remaining = max(0, deadline.timeIntervalSinceNow * 1000)
      if poll(&event, 1, Int32(remaining)) > 0 {
        var error: Int32 = 0
        var size = socklen_t(MemoryLayout<Int32>.size)
        if getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0 { return fd }
      }
    }
    Darwin.close(fd)
    if Date() >= deadline { break }
  }
  throw SshFailure(code: "ssh-unreachable", message: "could not reach the SSH host")
}

private func listener(_ preferred: Int) throws -> (Int32, Int) {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { throw SshFailure(code: "ssh-local-port", message: "could not open a local port") }
  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  address.sin_port = UInt16(preferred).bigEndian
  func bindAddress() -> Int32 {
    withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
  }
  var bound = bindAddress()
  if bound != 0 && preferred > 0 && errno == EADDRINUSE {
    address.sin_port = 0
    bound = bindAddress()
  }
  var size = socklen_t(MemoryLayout<sockaddr_in>.size)
  let measured = withUnsafeMutablePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &size) }
  }
  guard bound == 0, measured == 0, listen(fd, 16) == 0 else {
    Darwin.close(fd)
    throw SshFailure(code: "ssh-local-port", message: "could not open a local port")
  }
  nonblocking(fd)
  return (fd, Int(UInt16(bigEndian: address.sin_port)))
}

private final class SshPeer {
  let socket: Int32
  let channel: OpaquePointer
  let forwardPort: Int
  // Keep the address and contents stable while libssh2 retries an EAGAIN write.
  let upload = UnsafeMutablePointer<CChar>.allocate(capacity: 32768)
  var uploadSize = 0
  var uploadOffset = 0
  var download = Data()
  var localEOF = false
  var sentEOF = false

  init(socket: Int32, channel: OpaquePointer, forwardPort: Int) {
    self.socket = socket
    self.channel = channel
    self.forwardPort = forwardPort
  }
  deinit { upload.deallocate() }
}

/** One serial owner for the SSH session and every direct-tcpip channel on it. */
final class SshTransport {
  private static let initialized: Int32 = libssh2_init(0)
  let signature: String
  private(set) var hostKey = ""
  private let queue = DispatchQueue(label: "muxr.ssh.transport")
  private let state = NSLock()
  private let queueKey = DispatchSpecificKey<Bool>()
  private var stopped = false
  private var session: OpaquePointer?
  private var socket: Int32
  private var forwards: [Int: (socket: Int32, remotePort: Int)] = [:]
  private var peers: [SshPeer] = []
  private var retiredChannels: [OpaquePointer] = []
  private var timer: DispatchSourceTimer?
  private var lastInbound = Date()
  private let timeout: TimeInterval
  private(set) var localPort = 0

  var alive: Bool { state.withLock { !stopped } }

  init(_ config: SshConfiguration) throws {
    try config.validate()
    guard Self.initialized == 0 else { throw SshFailure(code: "ssh-unreachable", message: "could not initialize SSH") }
    signature = config.signature
    timeout = config.timeout
    socket = try dial(config)
    guard let opened = libssh2_session_init_ex(nil, nil, nil, nil) else {
      Darwin.close(socket)
      throw SshFailure(code: "ssh-unreachable", message: "could not initialize SSH")
    }
    session = opened
    // Nonblocking calls share a bounded network deadline; credentials stay in memory.
    libssh2_session_set_blocking(opened, 0)
    do {
      try Self.retry(opened, socket, timeout: timeout, code: "ssh-unreachable") {
        libssh2_session_handshake(opened, socket)
      }
      var length = 0
      var type: Int32 = 0
      guard let bytes = libssh2_session_hostkey(opened, &length, &type), length > 0 else {
        throw SshFailure(code: "ssh-host-key", message: "the server did not present a host key")
      }
      let digest = SHA256.hash(data: Data(bytes: bytes, count: length))
      hostKey = "SHA256:" + Data(digest).base64EncodedString().replacingOccurrences(of: "=", with: "")
      if let expected = config.knownHostKey, !expected.isEmpty, expected != hostKey {
        throw SshFailure(code: "ssh-host-key", message: "the SSH host key changed")
      }
      try Self.retry(opened, socket, timeout: timeout, code: "ssh-auth") {
        if let key = config.privateKey, !key.isEmpty {
          return key.withCString { keyBytes in
            config.username.withCString { user in
              libssh2_userauth_publickey_frommemory(opened, user, config.username.utf8.count, nil, 0, keyBytes, key.utf8.count, config.passphrase)
            }
          }
        }
        guard let password = config.password, !password.isEmpty else { return -1 }
        return libssh2_userauth_password_ex(opened, config.username, UInt32(config.username.utf8.count), password, UInt32(password.utf8.count), nil)
      }
      libssh2_keepalive_config(opened, 1, 15)
      queue.setSpecific(key: queueKey, value: true)
    } catch {
      _ = Darwin.shutdown(socket, SHUT_RDWR)
      libssh2_session_free(opened)
      Darwin.close(socket)
      session = nil
      socket = -1
      throw error
    }
  }

  private static func wait(_ session: OpaquePointer, _ socket: Int32, deadline: Date) throws {
    let remaining = deadline.timeIntervalSinceNow
    guard remaining > 0 else { throw SshFailure(code: "ssh-unreachable", message: "the SSH connection timed out") }
    let directions = libssh2_session_block_directions(session)
    var events: Int16 = 0
    if directions & LIBSSH2_SESSION_BLOCK_INBOUND != 0 { events |= Int16(POLLIN) }
    if directions & LIBSSH2_SESSION_BLOCK_OUTBOUND != 0 { events |= Int16(POLLOUT) }
    if events == 0 { events = Int16(POLLIN | POLLOUT) }
    var descriptor = pollfd(fd: socket, events: events, revents: 0)
    let result = poll(&descriptor, 1, Int32(min(remaining * 1000, 100)))
    if result < 0 && errno != EINTR { throw SshFailure(code: "ssh-unreachable", message: "the SSH connection closed") }
    if descriptor.revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0 {
      throw SshFailure(code: "ssh-unreachable", message: "the SSH connection closed")
    }
  }

  private static func retry(_ session: OpaquePointer, _ socket: Int32, timeout: TimeInterval, code: String, _ action: () -> Int32) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
      let result = action()
      if result == 0 { return }
      guard result == LIBSSH2_ERROR_EAGAIN else {
        let message = code == "ssh-auth" ? "the SSH server rejected these credentials" : "the SSH connection failed"
        throw SshFailure(code: code, message: message)
      }
      try wait(session, socket, deadline: deadline)
    }
  }

  func start(preferredPort: Int, remotePort: Int) throws -> Int {
    try queue.sync {
      let port = try addForward(preferredPort: preferredPort, remotePort: remotePort)
      localPort = port
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now(), repeating: .milliseconds(10))
      timer.setEventHandler { [weak self] in self?.pump() }
      self.timer = timer
      timer.resume()
      return port
    }
  }

  private func addForward(preferredPort: Int, remotePort: Int) throws -> Int {
    guard alive else { throw SshFailure(code: "ssh-unreachable", message: "no SSH connection is open") }
    let (fd, port) = try listener(preferredPort)
    forwards[port] = (fd, remotePort)
    return port
  }

  func openForward(_ remotePort: Int) throws -> Int {
    guard (1...65535).contains(remotePort) else { throw SshFailure(code: "ssh-configuration", message: "SSH ports are out of range") }
    return try queue.sync { try addForward(preferredPort: 0, remotePort: remotePort) }
  }

  func closeForward(_ port: Int) {
    queue.sync {
      guard let forward = forwards.removeValue(forKey: port) else { return }
      Darwin.close(forward.socket)
      peers = peers.filter { peer in
        if peer.forwardPort != port { return true }
        retire(peer)
        return false
      }
    }
  }

  private func retire(_ peer: SshPeer) {
    Darwin.close(peer.socket)
    if libssh2_channel_free(peer.channel) == LIBSSH2_ERROR_EAGAIN { retiredChannels.append(peer.channel) }
  }

  private func pump() {
    guard alive, let session else { return }
    var probe: CChar = 0
    let available = recv(socket, &probe, 1, MSG_PEEK)
    if available == 0 || (available < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
      shutdownOnQueue()
      return
    }
    if available > 0 { lastInbound = Date() }
    if !peers.isEmpty && Date().timeIntervalSince(lastInbound) > 45 {
      shutdownOnQueue()
      return
    }
    retiredChannels = retiredChannels.filter { libssh2_channel_free($0) == LIBSSH2_ERROR_EAGAIN }
    var nextKeepalive: Int32 = 0
    let keepalive = libssh2_keepalive_send(session, &nextKeepalive)
    if keepalive < 0 && keepalive != LIBSSH2_ERROR_EAGAIN {
      shutdownOnQueue()
      return
    }
    for (port, forward) in forwards {
      if peers.count >= 32 { break }
      let fd = accept(forward.socket, nil, nil)
      if fd < 0 { continue }
      nonblocking(fd)
      let deadline = Date().addingTimeInterval(timeout)
      var channel: OpaquePointer?
      do {
        repeat {
          channel = libssh2_channel_direct_tcpip_ex(session, "127.0.0.1", Int32(forward.remotePort), "127.0.0.1", Int32(port))
          if channel != nil { break }
          if libssh2_session_last_errno(session) != LIBSSH2_ERROR_EAGAIN { break }
          try Self.wait(session, socket, deadline: deadline)
        } while alive
      } catch { channel = nil }
      guard let channel else { Darwin.close(fd); continue }
      peers.append(SshPeer(socket: fd, channel: channel, forwardPort: port))
    }
    peers = peers.filter { peer in
      if transfer(peer) { return true }
      retire(peer)
      return false
    }
  }

  private func transfer(_ peer: SshPeer) -> Bool {
    if peer.uploadOffset == peer.uploadSize && !peer.localEOF {
      let count = recv(peer.socket, peer.upload, 32768, 0)
      if count == 0 { peer.localEOF = true }
      if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { return false }
      if count > 0 { peer.uploadOffset = 0; peer.uploadSize = count }
    }
    if peer.uploadOffset < peer.uploadSize {
      let count = libssh2_channel_write_ex(peer.channel, 0, peer.upload.advanced(by: peer.uploadOffset), peer.uploadSize - peer.uploadOffset)
      if count < 0 && count != LIBSSH2_ERROR_EAGAIN { return false }
      if count > 0 { peer.uploadOffset += count }
    } else if peer.localEOF && !peer.sentEOF {
      let result = libssh2_channel_send_eof(peer.channel)
      if result == 0 { peer.sentEOF = true }
      else if result != LIBSSH2_ERROR_EAGAIN { return false }
    }
    if peer.download.isEmpty {
      var buffer = [CChar](repeating: 0, count: 32768)
      let count = libssh2_channel_read_ex(peer.channel, 0, &buffer, buffer.count)
      if count < 0 && count != LIBSSH2_ERROR_EAGAIN { return false }
      if count > 0 { peer.download = Data(bytes: buffer, count: count) }
    }
    if !peer.download.isEmpty {
      let count = peer.download.withUnsafeBytes { send(peer.socket, $0.baseAddress, $0.count, 0) }
      if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { return false }
      if count > 0 { peer.download.removeFirst(count) }
    }
    return libssh2_channel_eof(peer.channel) == 0 || !peer.download.isEmpty
  }

  func command(_ command: String) throws -> [String: Any] {
    guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          command.utf16.count <= 131072, !command.contains("\0") else {
      throw SshFailure(code: "ssh-configuration", message: "SSH command is empty or too large")
    }
    return try queue.sync {
      guard alive, let session else { throw SshFailure(code: "ssh-unreachable", message: "no SSH connection is open") }
      let deadline = Date().addingTimeInterval(timeout)
      var channel: OpaquePointer?
      repeat {
        channel = libssh2_channel_open_ex(session, "session", 7, 2097152, 32768, nil, 0)
        if channel != nil { break }
        guard libssh2_session_last_errno(session) == LIBSSH2_ERROR_EAGAIN else { throw SshFailure(code: "ssh-unreachable", message: "could not open an SSH command session") }
        try Self.wait(session, socket, deadline: deadline)
      } while alive
      guard let channel else { throw SshFailure(code: "ssh-unreachable", message: "the SSH connection closed") }
      defer { if libssh2_channel_free(channel) == LIBSSH2_ERROR_EAGAIN { retiredChannels.append(channel) } }
      try Self.retry(session, socket, timeout: timeout, code: "ssh-unreachable") {
        libssh2_channel_process_startup(channel, "exec", 4, command, UInt32(command.utf8.count))
      }
      var output = [Data(), Data()]
      while alive {
        var drained = true
        for stream in 0...1 {
          var buffer = [CChar](repeating: 0, count: 8192)
          let count = libssh2_channel_read_ex(channel, Int32(stream), &buffer, buffer.count)
          if count < 0 && count != LIBSSH2_ERROR_EAGAIN { throw SshFailure(code: "ssh-unreachable", message: "the SSH command connection closed") }
          if count > 0 { output[stream].append(Data(bytes: buffer, count: count)); drained = false }
          if output[stream].count > 256 * 1024 { throw SshFailure(code: "ssh-configuration", message: "SSH command output is too large") }
        }
        if drained && libssh2_channel_eof(channel) != 0 {
          // Drain buffered streams before reading the exit-status message.
          if libssh2_channel_wait_closed(channel) == 0 {
            return ["stdout": String(decoding: output[0], as: UTF8.self), "stderr": String(decoding: output[1], as: UTF8.self), "exitCode": Int(libssh2_channel_get_exit_status(channel))]
          }
        }
        if Date() >= deadline { throw SshFailure(code: "ssh-exec-timeout", message: "the SSH command did not finish in time; its outcome is unknown") }
        // Keep the relay and desktop channels moving while a command runs.
        pump()
        try Self.wait(session, socket, deadline: deadline)
      }
      throw SshFailure(code: "ssh-unreachable", message: "the SSH connection closed")
    }
  }

  func close() {
    state.withLock { stopped = true }
    if DispatchQueue.getSpecific(key: queueKey) == true { shutdownOnQueue(); return }
    queue.sync { shutdownOnQueue() }
  }

  private func shutdownOnQueue() {
    state.withLock { stopped = true }
    timer?.cancel()
    timer = nil
    for forward in forwards.values { Darwin.close(forward.socket) }
    forwards.removeAll()
    for peer in peers { Darwin.close(peer.socket) }
    peers.removeAll()
    retiredChannels.removeAll()
    if let session {
      // Socket shutdown makes free nonblocking even on a lost network.
      _ = Darwin.shutdown(socket, SHUT_RDWR)
      libssh2_session_free(session)
      self.session = nil
    }
    if socket >= 0 { Darwin.close(socket); socket = -1 }
  }

  deinit { close() }
}
