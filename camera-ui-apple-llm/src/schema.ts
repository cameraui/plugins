export function appleSchema(schema: Record<string, unknown>, name = 'Output'): Record<string, unknown> {
  const type = schema.type;
  if (type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const keys = Object.keys(properties);
    const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((key) => keys.includes(key)) : keys;
    return {
      type: 'object',
      title: typeof schema.title === 'string' ? schema.title : name,
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
      properties: Object.fromEntries(keys.map((key) => [key, appleSchema(properties[key], capitalize(key))])),
      'x-order': keys,
      required,
      additionalProperties: false,
    };
  }

  if (type === 'array') {
    const items = (schema.items ?? { type: 'string' }) as Record<string, unknown>;
    return { ...schema, type: 'array', items: appleSchema(items, `${name}Item`) };
  }

  return schema;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
