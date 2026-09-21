import CoreGraphics
import Foundation
import FoundationModels
import ImageIO

let continuation = "Continue from the tool results above and answer the user."
let parkedLimit = 6
let parkedLifetime: TimeInterval = 300
let countsTokens = ProcessInfo.processInfo.environment["APPLE_LLM_USAGE"] != nil
let debugs = ProcessInfo.processInfo.environment["APPLE_LLM_DEBUG"] != nil

struct Setup {
  let key: String
  let instructions: String
  let tools: [WireTool]
  let permissive: Bool

  init(_ request: WireRequest) {
    instructions = (request.system ?? []).joined(separator: "\n\n")
    tools = request.tools ?? []
    permissive = request.permissive == true
    key = [instructions, tools.map { "\($0.name)\($0.description)\($0.inputSchema.json)" }.joined(), String(permissive)].joined(separator: "\u{1}")
  }

  var model: SystemLanguageModel {
    permissive ? SystemLanguageModel(guardrails: .permissiveContentTransformations) : SystemLanguageModel.default
  }
}

struct Parked {
  let turn: Turn
  let task: Task<Void, Never>
  let key: String
  let base: [String]
  let ids: Set<String>
}

actor Sessions {
  private var parked: [Parked] = []
  private var active: [ObjectIdentifier: (turn: Turn, task: Task<Void, Never>)] = [:]

  var busy: Bool { !active.isEmpty }

  func start(_ turn: Turn, _ task: Task<Void, Never>) {
    active[ObjectIdentifier(turn)] = (turn, task)
  }

  func finish(_ turn: Turn) {
    active[ObjectIdentifier(turn)] = nil
  }

  func park(_ entry: Parked) {
    active[ObjectIdentifier(entry.turn)] = nil
    parked.append(entry)
    while parked.count > parkedLimit { drop(parked.removeFirst()) }
  }

  func takeParked(key: String, messages: [WireMessage]) -> (entry: Parked, results: [String: Prompt])? {
    sweep()
    let prints = messages.map(fingerprint)
    for (index, entry) in parked.enumerated() {
      guard entry.key == key, prints.count == entry.base.count + 1 + entry.ids.count, Array(prints.prefix(entry.base.count)) == entry.base else { continue }
      let rest = Array(messages.dropFirst(entry.base.count))
      guard rest[0].role == "assistant", Set((rest[0].toolCalls ?? []).map(\.id)) == entry.ids else { continue }
      let answers = rest.dropFirst()
      guard answers.allSatisfy({ $0.role == "tool" }), Set(answers.compactMap(\.toolCallId)) == entry.ids else { continue }

      parked.remove(at: index)
      var results: [String: Prompt] = [:]
      for answer in answers { results[answer.toolCallId ?? ""] = prompt(answer.content, fallback: "No result.") }
      return (entry, results)
    }
    return nil
  }

  func cancel(request: String) {
    for (key, entry) in active where entry.turn.owner == request {
      entry.task.cancel()
      entry.turn.abandon()
      active[key] = nil
    }
  }

  private func sweep() {
    let expired = parked.filter { Date().timeIntervalSince($0.turn.parkedAt ?? Date()) > parkedLifetime }
    parked.removeAll { entry in expired.contains { $0.turn === entry.turn } }
    expired.forEach(drop)
  }

  private func drop(_ entry: Parked) {
    entry.task.cancel()
    entry.turn.abandon()
  }
}

let sessions = Sessions()

func fingerprint(role: String, text: String, calls: String = "", toolCallId: String = "") -> String {
  [role, text.trimmingCharacters(in: .whitespacesAndNewlines), calls, toolCallId].joined(separator: "\u{1}")
}

func fingerprint(_ message: WireMessage) -> String {
  let text = message.content.map { $0.type == "text" ? ($0.text ?? "") : "[image]" }.joined(separator: "\u{2}")
  return fingerprint(role: message.role, text: text, calls: (message.toolCalls ?? []).map(\.id).joined(separator: ","), toolCallId: message.toolCallId ?? "")
}

func reason(_ availability: SystemLanguageModel.Availability) -> String {
  switch availability {
  case .available: return "available"
  case .unavailable(.deviceNotEligible): return "deviceNotEligible"
  case .unavailable(.appleIntelligenceNotEnabled): return "appleIntelligenceNotEnabled"
  case .unavailable(.modelNotReady): return "modelNotReady"
  case .unavailable: return "unknown"
  }
}

func image(_ base64: String) -> CGImage? {
  guard let data = Data(base64Encoded: base64), let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func prompt(_ content: [WireContent], fallback: String) -> Prompt {
  let text = content.compactMap { $0.type == "text" ? $0.text : nil }.joined(separator: "\n")
  let pictures = content.compactMap { $0.type == "image" ? $0.data.flatMap(image) : nil }
  if #available(macOS 27.0, *), !pictures.isEmpty {
    return Prompt {
      text.isEmpty ? "Look at the picture." : text
      for picture in pictures { Attachment(picture) }
    }
  }
  return Prompt(text.isEmpty ? fallback : text)
}

func segments(_ content: [WireContent], images allowed: Bool) -> [Transcript.Segment] {
  var out: [Transcript.Segment] = []
  for part in content {
    if part.type == "text", let text = part.text, !text.isEmpty {
      out.append(.text(Transcript.TextSegment(content: text)))
    } else if allowed, part.type == "image", let data = part.data, let cgImage = image(data), #available(macOS 27.0, *) {
      out.append(.attachment(Transcript.AttachmentSegment(content: .image(Transcript.ImageAttachment(cgImage)))))
    }
  }
  return out
}

func transcript(instructions: String, messages: [WireMessage]) -> Transcript {
  var names: [String: String] = [:]
  var entries: [Transcript.Entry] = []
  if !instructions.isEmpty {
    entries.append(.instructions(Transcript.Instructions(segments: [.text(Transcript.TextSegment(content: instructions))], toolDefinitions: [])))
  }
  for message in messages {
    switch message.role {
    case "user":
      entries.append(.prompt(Transcript.Prompt(segments: segments(message.content, images: false))))
    case "assistant":
      let text = segments(message.content, images: false)
      if !text.isEmpty { entries.append(.response(Transcript.Response(assetIDs: [], segments: text))) }
      let calls = (message.toolCalls ?? []).compactMap { call -> Transcript.ToolCall? in
        names[call.id] = call.name
        guard let arguments = try? GeneratedContent(json: call.arguments.json) else { return nil }
        return Transcript.ToolCall(id: call.id, toolName: call.name, arguments: arguments)
      }
      if !calls.isEmpty { entries.append(.toolCalls(Transcript.ToolCalls(calls))) }
    case "tool":
      let id = message.toolCallId ?? UUID().uuidString
      entries.append(.toolOutput(Transcript.ToolOutput(id: id, toolName: names[id] ?? "tool", segments: segments(message.content, images: true))))
    default:
      continue
    }
  }
  return Transcript(entries: entries)
}

func build(_ setup: Setup, history: [WireMessage], request: String?) -> (session: LanguageModelSession, turn: Turn) {
  let turn = Turn(request: request, tools: setup.tools)
  var builder = SchemaBuilder()
  var tools: [any Tool] = []
  for tool in setup.tools {
    guard let parameters = try? builder.root(name: tool.name, schema: tool.inputSchema) else { continue }
    tools.append(HostTool(name: tool.name, description: tool.description, parameters: parameters, turn: turn))
  }
  let session = LanguageModelSession(model: setup.model, tools: tools, transcript: transcript(instructions: setup.instructions, messages: history))
  return (session, turn)
}

func run(_ setup: Setup, _ request: WireRequest, session: LanguageModelSession, turn: Turn, question: Prompt) async {
  let messages = request.messages ?? []
  var options = GenerationOptions()
  options.maximumResponseTokens = request.maxOutputTokens
  var builder = SchemaBuilder()
  let schema = request.outputSchema.flatMap { try? builder.root(name: "answer", schema: $0) }
  let model = setup.model

  turn.promptTokens = {
    guard countsTokens, #available(macOS 27.0, *) else { return 0 }
    return (try? await model.tokenCount(for: Array(session.transcript))) ?? 0
  }

  let task = Task {
    do {
      var answer = ""
      if let schema {
        answer = try await session.respond(to: question, schema: schema, options: options).content.jsonString
        turn.text(answer)
      } else {
        for try await snapshot in session.streamResponse(to: question, options: options) {
          answer = snapshot.content
          turn.text(answer)
        }
      }

      var usage: (prompt: Int, completion: Int)?
      if countsTokens, #available(macOS 27.0, *) {
        let used = (try? await model.tokenCount(for: Array(session.transcript))) ?? 0
        let completion = (try? await model.tokenCount(for: answer)) ?? 0
        if used > 0 { usage = (max(0, used - completion), completion) }
      }
      turn.finish("stop", usage: usage)
    } catch {
      if !Task.isCancelled {
        turn.finish("error", message: String(describing: error).split(separator: "\n").first.map(String.init) ?? "generation failed")
      }
    }
    await sessions.finish(turn)
  }

  let base = messages.map(fingerprint)
  turn.onParked = { ids in await sessions.park(Parked(turn: turn, task: task, key: setup.key, base: base, ids: ids)) }
  await sessions.start(turn, task)
}

func generate(_ request: WireRequest) async {
  let setup = Setup(request)
  let messages = request.messages ?? []

  if request.outputSchema == nil, let match = await sessions.takeParked(key: setup.key, messages: messages) {
    let base = messages.map(fingerprint)
    let turn = match.entry.turn
    let task = match.entry.task
    turn.onParked = { ids in await sessions.park(Parked(turn: turn, task: task, key: setup.key, base: base, ids: ids)) }
    await sessions.start(turn, task)
    turn.resume(request: request.id, results: match.results)
    if debugs { FileHandle.standardError.write(Data("resumed a parked session\n".utf8)) }
    return
  }

  guard setup.model.availability == .available else {
    Output.done("error", message: "The Apple on-device model is not available: \(reason(setup.model.availability))", request: request.id)
    return
  }

  var history = messages
  var last: WireMessage?
  if history.last?.role == "user" { last = history.removeLast() }
  let built = build(setup, history: history, request: request.id)
  await run(setup, request, session: built.session, turn: built.turn, question: prompt(last?.content ?? [], fallback: continuation))
}

func status(_ request: WireRequest) {
  let model = SystemLanguageModel.default
  var fields: [String: Any] = ["available": model.availability == .available, "reason": reason(model.availability)]
  if #available(macOS 27.0, *) {
    fields["contextSize"] = model.contextSize
    fields["variant"] = model.variant.displayName
  }
  Output.emit(fields, request: request.id)
}

for try await line in FileHandle.standardInput.bytes.lines {
  guard let request = try? JSONDecoder().decode(WireRequest.self, from: Data(line.utf8)) else {
    Output.done("error", message: "The request is not valid JSON", request: nil)
    continue
  }
  switch request.mode {
  case "status": status(request)
  case "cancel": if let id = request.id { await sessions.cancel(request: id) }
  default: await generate(request)
  }
}

while await sessions.busy { try await Task.sleep(for: .milliseconds(50)) }
