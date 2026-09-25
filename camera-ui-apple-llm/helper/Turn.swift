import Foundation
import FoundationModels

struct PendingCall {
  let id: String
  let name: String
  let arguments: String
}

final class Turn: @unchecked Sendable {
  private let lock = NSLock()
  private let tools: [WireTool]
  private var request: String?
  private var emitted = ""
  private var waiting: [String: CheckedContinuation<Prompt, Error>] = [:]
  private var announced: [PendingCall] = []
  private var flushing = false
  private(set) var parkedAt: Date?

  var onParked: (@Sendable (Set<String>) async -> Void)?
  var promptTokens: (@Sendable () async -> Int)?

  init(request: String?, tools: [WireTool]) {
    self.request = request
    self.tools = tools
  }

  var owner: String? {
    lock.lock()
    defer { lock.unlock() }
    return request
  }

  func text(_ content: String) {
    lock.lock()
    // the snapshot restarts after a tool round, then the whole content is new
    let delta = content.hasPrefix(emitted) ? String(content.dropFirst(emitted.count)) : content
    emitted = content
    let request = request
    lock.unlock()
    Output.text(delta, request: request)
  }

  func finish(_ finish: String, message: String? = nil, usage: (prompt: Int, completion: Int)? = nil) {
    lock.lock()
    let request = request
    lock.unlock()
    if let usage { Output.emit(["type": "usage", "promptTokens": usage.prompt, "completionTokens": usage.completion], request: request) }
    Output.done(finish, message: message, request: request)
  }

  func wait(name: String, arguments: String) async throws -> Prompt {
    let id = "call-\(UUID().uuidString.prefix(8))"
    return try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      waiting[id] = continuation
      announced.append(PendingCall(id: id, name: name, arguments: arguments))
      let schedule = !flushing
      flushing = true
      lock.unlock()
      // calls of one model turn arrive together, a short wait collects them into one answer
      if schedule { Task { try? await Task.sleep(for: .milliseconds(150)); await self.flush() } }
    }
  }

  func resume(request: String?, results: [String: Prompt]) {
    lock.lock()
    self.request = request
    emitted = ""
    parkedAt = nil
    let continuations = waiting
    waiting = [:]
    lock.unlock()
    for (id, continuation) in continuations { continuation.resume(returning: results[id] ?? Prompt("No result.")) }
  }

  func abandon() {
    lock.lock()
    let continuations = waiting
    waiting = [:]
    lock.unlock()
    for continuation in continuations.values { continuation.resume(throwing: CancellationError()) }
  }

  private func takeAnnounced() -> (calls: [PendingCall], request: String?) {
    lock.lock()
    defer { lock.unlock() }
    let calls = announced
    announced = []
    flushing = false
    parkedAt = Date()
    return (calls, request)
  }

  private func flush() async {
    let used = await promptTokens?() ?? 0
    let (calls, request) = takeAnnounced()
    // parked before the host hears about the calls, its next request may arrive at once
    await onParked?(Set(calls.map(\.id)))

    for call in calls {
      let parsed = (try? JSONDecoder().decode(JSONValue.self, from: Data(call.arguments.utf8))) ?? .object([:])
      let restored = restore(parsed, schema: tools.first { $0.name == call.name }?.inputSchema)
      let arguments = (try? JSONSerialization.jsonObject(with: Data(restored.json.utf8))) ?? [String: Any]()
      Output.emit(["type": "tool_call", "call": ["id": call.id, "name": call.name, "arguments": arguments]], request: request)
    }
    if used > 0 { Output.emit(["type": "usage", "promptTokens": used, "completionTokens": 0], request: request) }
    Output.done("tool_calls", request: request)
  }
}

struct HostTool: Tool {
  let name: String
  let description: String
  let parameters: GenerationSchema
  let turn: Turn

  // the host runs the tool, the session waits here until the next request brings the result
  func call(arguments: GeneratedContent) async throws -> Prompt {
    try await turn.wait(name: name, arguments: arguments.jsonString)
  }
}

func restore(_ value: JSONValue, schema: JSONValue?) -> JSONValue {
  guard let schema else { return value }
  if SchemaBuilder.isRecord(schema), case .array(let pairs) = value {
    return .object(pairs.reduce(into: [:]) { out, pair in
      guard let key = pair["key"]?.string, let text = pair["value"]?.string else { return }
      out[key] = (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .string(text)
    })
  }
  if case .object(let fields) = value, let properties = schema["properties"]?.object {
    return .object(fields.reduce(into: [:]) { out, field in out[field.key] = restore(field.value, schema: properties[field.key]) })
  }
  if case .array(let items) = value {
    return .array(items.map { restore($0, schema: schema["items"]) })
  }
  return value
}
