import Foundation

enum HappierCryptoWorkerTypes {
  static let moduleVersion = 1
  static let platform = "ios"
  static let serializedJsonEnvelopeFlag = "__happierSerializedJsonValueV1"
  static let supportedOperations = [
    "decryptDataKeyEnvelopeV1",
    "decryptSecretboxJson",
    "decryptAesGcmJson",
    "echoBatchForDiagnostics",
  ]
}

enum HappierCryptoWorkerSerializedJson {
  static func parseEnvelopeOrOriginal(_ value: String) -> Any? {
    guard let data = value.data(using: .utf8) else { return value }
    guard let parsed = try? JSONSerialization.jsonObject(with: data) else { return value }
    guard let object = parsed as? [String: Any] else { return parsed }
    guard (object[HappierCryptoWorkerTypes.serializedJsonEnvelopeFlag] as? Bool) == true else {
      return parsed
    }

    switch object["type"] as? String {
    case "undefined":
      return object
    case "json":
      return object["value"]
    default:
      return value
    }
  }
}
