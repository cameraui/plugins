import Foundation
import FoundationModels

enum SchemaError: Error {
  case notAnObject
}

struct SchemaBuilder {
  private var counter = 0

  private mutating func uniqueName(_ hint: String) -> String {
    counter += 1
    return "\(hint)_\(counter)"
  }

  mutating func root(name: String, schema: JSONValue) throws -> GenerationSchema {
    guard schema.object != nil else { throw SchemaError.notAnObject }
    return try GenerationSchema(root: object(name: name, schema: schema), dependencies: [])
  }

  private mutating func object(name: String, schema: JSONValue) -> DynamicGenerationSchema {
    let required = Set((schema["required"]?.array ?? []).compactMap(\.string))
    let fields = schema["properties"]?.object ?? [:]
    let properties = fields.keys.sorted().map { key -> DynamicGenerationSchema.Property in
      let field = fields[key] ?? .null
      return DynamicGenerationSchema.Property(
        name: key,
        description: field["description"]?.string,
        schema: value(hint: key, schema: field),
        isOptional: !required.contains(key)
      )
    }
    return DynamicGenerationSchema(name: name, description: schema["description"]?.string, properties: properties)
  }

  private mutating func value(hint: String, schema: JSONValue) -> DynamicGenerationSchema {
    if let choices = schema["enum"]?.array {
      let strings = choices.compactMap(\.string)
      if !strings.isEmpty { return DynamicGenerationSchema(name: uniqueName(hint), anyOf: strings) }
    }

    // zod emits anyOf for unions and nullable fields, the first real branch carries the shape
    if let branches = schema["anyOf"]?.array ?? schema["oneOf"]?.array {
      let real = branches.first { $0["type"]?.string != "null" }
      if let real { return value(hint: hint, schema: real) }
    }

    switch Self.typeName(schema) {
    case "object":
      if Self.isRecord(schema) { return record(hint: hint) }
      return object(name: uniqueName(hint), schema: schema)
    case "array":
      return DynamicGenerationSchema(
        arrayOf: value(hint: hint, schema: schema["items"] ?? .null),
        minimumElements: schema["minItems"]?.int,
        maximumElements: schema["maxItems"]?.int
      )
    case "integer":
      return DynamicGenerationSchema(type: Int.self)
    case "number":
      return DynamicGenerationSchema(type: Double.self)
    case "boolean":
      return DynamicGenerationSchema(type: Bool.self)
    default:
      return DynamicGenerationSchema(type: String.self)
    }
  }

  private mutating func record(hint: String) -> DynamicGenerationSchema {
    let pair = DynamicGenerationSchema(
      name: uniqueName("\(hint)_entry"),
      properties: [
        DynamicGenerationSchema.Property(name: "key", schema: DynamicGenerationSchema(type: String.self)),
        DynamicGenerationSchema.Property(name: "value", schema: DynamicGenerationSchema(type: String.self)),
      ]
    )
    return DynamicGenerationSchema(arrayOf: pair)
  }

  static func isRecord(_ schema: JSONValue) -> Bool {
    typeName(schema) == "object" && schema["properties"]?.object == nil && schema["enum"] == nil
  }

  static func typeName(_ schema: JSONValue) -> String {
    if let name = schema["type"]?.string { return name }
    // ["string", "null"]
    let names = (schema["type"]?.array ?? []).compactMap(\.string)
    return names.first { $0 != "null" } ?? "string"
  }
}
