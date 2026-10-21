/**
 * Reading the config schema's own structure: which keys an object allows (for
 * "unknown key … did you mean"), and every leaf key (for the parity test
 * against `docs/CONFIG.md`). Zod 4 keeps a schema's definition on `_zod.def`.
 */
import type { z } from "zod";

/** The part of a zod definition this module reads. */
interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  valueType?: z.ZodType;
  element?: z.ZodType;
}

/**
 * A schema's definition.
 * @param schema - Any zod schema.
 * @returns Its definition.
 */
function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/**
 * Strip wrappers that do not change a value's structure: optional, default,
 * prefault, nullable, and a transform's input side.
 * @param schema - A schema.
 * @returns The structural schema underneath.
 */
export function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = defOf(current);
    if (
      def.innerType &&
      ["optional", "default", "prefault", "nullable", "readonly"].includes(
        def.type,
      )
    ) {
      current = def.innerType;
    } else if (def.type === "pipe" && def.in) {
      current = def.in;
    } else {
      return current;
    }
  }
}

/**
 * The schema at a path through objects, records, and arrays.
 * @param schema - The root schema.
 * @param path - Keys and indices, as a zod issue reports them.
 * @returns The schema there, or undefined when the path leaves the schema.
 */
export function schemaAt(
  schema: z.ZodType,
  path: readonly PropertyKey[],
): z.ZodType | undefined {
  let current: z.ZodType | undefined = schema;
  for (const segment of path) {
    if (!current) return undefined;
    const def = defOf(unwrap(current));
    if (def.type === "object") current = def.shape?.[String(segment)];
    else if (def.type === "record") current = def.valueType;
    else if (def.type === "array") current = def.element;
    else return undefined;
  }
  return current;
}

/**
 * The keys an object schema allows.
 * @param schema - A schema (wrappers are stripped).
 * @returns Its keys, or none for anything but an object.
 */
export function objectKeys(schema: z.ZodType | undefined): string[] {
  if (!schema) return [];
  const def = defOf(unwrap(schema));
  return def.type === "object" ? Object.keys(def.shape ?? {}) : [];
}

/**
 * Every leaf key, dotted: a record's key is `*` and an array of objects is
 * `[]` (`agents.*.preset`, `repositories[].path`). A union is a leaf.
 * @param schema - The root schema.
 * @param prefix - The path so far.
 * @returns The leaf keys.
 */
export function leafKeys(schema: z.ZodType, prefix = ""): string[] {
  const def = defOf(unwrap(schema));
  if (def.type === "object") {
    return Object.entries(def.shape ?? {}).flatMap(([key, value]) =>
      leafKeys(value, prefix ? `${prefix}.${key}` : key),
    );
  }
  if (def.type === "record" && def.valueType) {
    const inner = defOf(unwrap(def.valueType));
    if (inner.type === "object") return leafKeys(def.valueType, `${prefix}.*`);
  }
  if (def.type === "array" && def.element) {
    const inner = defOf(unwrap(def.element));
    if (inner.type === "object") return leafKeys(def.element, `${prefix}[]`);
  }
  return [prefix];
}
