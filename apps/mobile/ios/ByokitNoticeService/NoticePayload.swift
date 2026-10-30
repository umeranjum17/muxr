import Foundation
import CoreFoundation
import Clibsodium
#if SWIFT_PACKAGE
import NoticeSession
#endif

struct NoticeContent {
  let title: String
  let body: String
  let data: [String: Any]?
}
enum NoticePayload {
  static func openTransport(_ fields: [AnyHashable: Any], key: Data, session: NoticeSession) -> NoticeContent? {
    guard !session.isSignedOut else { return nil }
    let expo = fields["body"] as? [String: Any]
    // `@byokit/relay` sends the envelope itself as `data`, which Expo carries at `body.data`.
    guard let payload = fields["notice"] ?? expo?["notice"] ?? expo?["data"] else { return nil }
    return open(payload, key: key)
  }
  static func open(_ payload: Any, key: Data) -> NoticeContent? {
    let envelope: [String: Any]?
    if let text = payload as? String, let bytes = text.data(using: .utf8) {
      envelope = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
    } else { envelope = payload as? [String: Any] }
    guard let envelope, let version = envelope["v"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
          let sealed = envelope["sealed"] as? String, sealed.count <= 8192,
          sealed.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
          sealed.count % 4 != 1, key.count == 32 else { return nil }
    let padded = sealed.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - sealed.count % 4) % 4)
    guard let bundle = Data(base64Encoded: padded), bundle.count >= 72,
          bundle.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == sealed,
          sodium_init() >= 0 else { return nil }
    let publicKey = [UInt8](bundle.prefix(32))
    let nonce = [UInt8](bundle.dropFirst(32).prefix(24))
    let cipher = [UInt8](bundle.dropFirst(56))
    var secret = [UInt8](key)
    var plain = [UInt8](repeating: 0, count: cipher.count - 16)
    defer { secret.withUnsafeMutableBytes { sodium_memzero($0.baseAddress, $0.count) }; plain.withUnsafeMutableBytes { sodium_memzero($0.baseAddress, $0.count) } }
    guard crypto_box_open_easy(&plain, cipher, UInt64(cipher.count), nonce, publicKey, secret) == 0,
          String(bytes: plain, encoding: .utf8) != nil,
          let content = (try? JSONSerialization.jsonObject(with: Data(plain))) as? [String: Any],
          let title = content["title"] as? String, !title.isEmpty,
          let body = content["body"] as? String else { return nil }
    if content["data"] != nil && !(content["data"] is [String: Any]) { return nil }
    return NoticeContent(title: title, body: body, data: content["data"] as? [String: Any])
  }
}
