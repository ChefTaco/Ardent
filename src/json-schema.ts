import { z } from 'zod';

export type JsonSchemaTarget = 'openapi-3.0' | 'draft-7';

/**
 * JSON Schema for a request-side Zod schema: tool parameters, API request
 * bodies, configuration, and model output contracts. Fields with defaults are
 * optional because callers may omit them, and refinements and transforms
 * describe what a caller sends. Nested schemas are inlined (no $ref).
 */
export function toJsonSchema(schema: z.ZodType, target: JsonSchemaTarget = 'draft-7'): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target, io: 'input', reused: 'inline', unrepresentable: 'any',
    // Zod 4 emits oneOf for discriminated unions. Keep anyOf (equivalent for
    // exclusive variants) because some function-calling schema dialects reject oneOf.
    override: ({ jsonSchema }) => {
      if (jsonSchema.oneOf) { jsonSchema.anyOf = jsonSchema.oneOf; delete jsonSchema.oneOf; }
    },
  });
}
