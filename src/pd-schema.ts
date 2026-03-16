/**
 * Schema compression utilities for progressive disclosure.
 * Pure functions — no I/O, no side effects.
 */

export function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * Compress a JSON Schema by stripping property descriptions, examples,
 * defaults, $comment, and redundant additionalProperties on nested objects.
 * Preserves: property names, type, required, enum, oneOf/anyOf/allOf.
 */
export function compressSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return compressNode(schema, /* isRoot */ true) as Record<string, unknown>;
}

function compressNode(node: unknown, isRoot: boolean): unknown {
  if (node === null || node === undefined || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => compressNode(item, false));
  }

  const obj = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Strip fields on non-root nodes
    if (!isRoot) {
      if (key === "description") continue;
      if (key === "examples") continue;
      if (key === "default") continue;
      if (key === "$comment") continue;
      if (key === "additionalProperties" && value === false) continue;
    }

    // Recurse into nested structures
    if (key === "properties" && typeof value === "object" && value !== null) {
      const props = value as Record<string, unknown>;
      const compressed: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        compressed[propName] = compressNode(propSchema, false);
      }
      result[key] = compressed;
    } else if (key === "items" && typeof value === "object") {
      result[key] = compressNode(value, false);
    } else if ((key === "oneOf" || key === "anyOf" || key === "allOf") && Array.isArray(value)) {
      result[key] = value.map((item) => compressNode(item, false));
    } else {
      result[key] = value;
    }
  }

  return result;
}
