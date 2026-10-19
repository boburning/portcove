import { orderedJsonValue as canonical } from "./json-values.mts";

export function renderTransportSchemas(schemas: unknown): string {
  if (
    !schemas ||
    typeof schemas !== "object" ||
    Array.isArray(schemas) ||
    Object.keys(schemas).length === 0 ||
    Object.values(schemas).some(
      (schema) => !schema || typeof schema !== "object" || Array.isArray(schema),
    )
  ) {
    throw new Error("Transport export must contain named JSON schemas");
  }
  return JSON.stringify(canonical(schemas), null, 2) + "\n";
}
