import { createHash } from "node:crypto";
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

export const orderedJsonSha256 = (value: unknown): string => {
  const serialized = JSON.stringify(orderedJsonValue(value));
  if (serialized === undefined) throw new TypeError("Observation is not JSON serializable");
  return createHash("sha256").update(serialized).digest("hex");
};
