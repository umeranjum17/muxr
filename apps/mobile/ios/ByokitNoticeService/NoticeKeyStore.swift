import Foundation
#if canImport(Security)
import Security
#endif

/// App and extension share one refusal flag. Only a successful setNoticeKey ends sign-out.
public struct NoticeSession {
  private let group: String
  private let flag = "byokit.notices.signed-out"
  public init(group: String) { self.group = group }
  public var isSignedOut: Bool {
    guard let defaults = UserDefaults(suiteName: group), defaults.synchronize() else { return true }
    return defaults.bool(forKey: flag)
  }
  private func setSignedOut(_ value: Bool) throws {
    guard let defaults = UserDefaults(suiteName: group) else { throw NoticeKeyError.unavailable }
    defaults.set(value, forKey: flag)
    // Publish to the other process before touching credentials or returning to JavaScript.
    guard defaults.synchronize() else { throw NoticeKeyError.unavailable }
  }
  public func declareSignedOut(clearKey: () throws -> Void, clearTargets: () throws -> Void) throws {
    try setSignedOut(true)
    var failure: Error?
    do { try clearKey() } catch { failure = error }
    do { try clearTargets() } catch { if failure == nil { failure = error } }
    if let failure { throw failure }
  }
  public func setKey(_ write: () throws -> Void) throws {
    try write()
    try setSignedOut(false)
  }
  public func requireSignedIn() throws {
    if isSignedOut { throw NoticeKeyError.signedOut }
  }
}

#if canImport(Security)
public struct NoticeKeyStore {
  let group: String
  public init(group: String) { self.group = group }
  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "byokit.notices",
     kSecAttrAccount as String: "device-secret", kSecAttrAccessGroup as String: group]
  }
  public func set(_ key: Data) throws {
    guard key.count == 32 else { throw NoticeKeyError.invalid }
    try NoticeSession(group: group).setKey {
      // Update in place: a failed rotation must not first delete the working key.
      let attributes: [String: Any] = [kSecValueData as String: key,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
      var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
      guard status == errSecSuccess else { throw NoticeKeyError.unavailable }
    }
  }
  public func get() -> Data? {
    guard !NoticeSession(group: group).isSignedOut else { return nil }
    var result: CFTypeRef?
    let read = query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { _, new in new }
    guard SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data, data.count == 32 else { return nil }
    return data
  }
  public func clear() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw NoticeKeyError.unavailable }
  }
}
#endif
public enum NoticeKeyError: LocalizedError {
  case invalid, unavailable, signedOut
  public var errorDescription: String? {
    switch self {
    case .signedOut: return "This device is signed out"
    case .invalid: return "The notice key is invalid"
    case .unavailable: return "The notice store is unavailable"
    }
  }
}
