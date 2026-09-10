function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function renderTransportSchemas(schemas) {
  if (
    !schemas ||
    typeof schemas !== "object" ||
    Array.isArray(schemas) ||
    Object.keys(schemas).length === 0 ||
    Object.values(schemas).some(
      (schema) =>
        !schema || typeof schema !== "object" || Array.isArray(schema),
    )
  ) {
    throw new Error("Transport export must contain named JSON schemas");
  }
  return JSON.stringify(canonical(schemas), null, 2) + "\n";
}
