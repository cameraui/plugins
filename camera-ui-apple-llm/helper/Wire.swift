import Foundation

struct WireContent: Decodable {
  let type: String
  let text: String?
  let data: String?
  let mimeType: String?
}

struct WireToolCall: Decodable {
  let id: String
  let name: String
  let arguments: JSONValue
}

struct WireMessage: Decodable {
  let role: String
  let content: [WireContent]
  let toolCalls: [WireToolCall]?
  let toolCallId: String?
}

struct WireTool: Decodable {
  let name: String
  let description: String
  let inputSchema: JSONValue
}

struct WireRequest: Decodable {
  let id: String?
  let mode: String
  let system: [String]?
  let messages: [WireMessage]?
  let tools: [WireTool]?
  let outputSchema: JSONValue?
  let maxOutputTokens: Int?
  let permissive: Bool?
}

enum JSONValue: Codable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }

  subscript(key: String) -> JSONValue? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }

  var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  var int: Int? {
    if case .number(let value) = self { return Int(value) }
    return nil
  }

  var array: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }

  var object: [String: JSONValue]? {
    if case .object(let value) = self { return value }
    return nil
  }

  var json: String {
    let encoder = JSONEncoder()
    // the text doubles as an identity of a tool set, so it must not depend on dictionary order
    encoder.outputFormatting = .sortedKeys
    guard let data = try? encoder.encode(self) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }
}

enum Output {
  private static let lock = NSLock()

  static func emit(_ fields: [String: Any], request: String? = nil) {
    var fields = fields
    if let request { fields["id"] = request }
    guard let data = try? JSONSerialization.data(withJSONObject: fields) else { return }
    lock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    lock.unlock()
  }

  static func text(_ delta: String, request: String?) {
    if !delta.isEmpty { emit(["type": "text", "delta": delta], request: request) }
  }

  static func done(_ finish: String, message: String? = nil, request: String?) {
    var fields: [String: Any] = ["type": "done", "finish": finish]
    if let message { fields["message"] = message }
    emit(fields, request: request)
  }
}
