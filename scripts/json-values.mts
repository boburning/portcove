import { isRecord } from "./runtime-values.mts";

/** Order object keys recursively while preserving array order and primitive values.
 * Serialization and refusal of unsupported values remain the caller's contract.
 */
export function orderedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJsonValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, orderedJsonValue(value[key])]),
    );
  return value;
}
