import { createHash } from "node:crypto";
import compact from "./testdata/desktop-execution-baseline.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";

type Expanded<Value> = Value extends { string_array: number }
  ? string[]
  : Value extends readonly (infer Item)[]
    ? Expanded<Item>[]
    : Value extends object
      ? { [Key in keyof Value]: Expanded<Value[Key]> }
      : Value;

// Independently calculated from the retained original before compaction and
// reviewed separately. Never regenerate this expectation from the planner.
export const historicalBaselineSha256 =
  "5ff0451a9a941cef695f6502575870f20218511f017c7c6d1e9b49f812e48876";
const originalBytesSha256 = "7b618227e72010de3d0cd0b23f5a64126e28e055285be8af25c521b540b78e31";

/** Decode only the mechanically compacted, immutable historical JSON oracle.
 * The exact pre-change digest validates its full shape and every expected value. */
export function decodeDesktopExecutionBaseline(input: unknown): Expanded<typeof compact.data> {
  if (
    !isRecord(input) ||
    input.format_version !== 1 ||
    input.original_sha256 !== originalBytesSha256 ||
    !Array.isArray(input.shared_string_arrays) ||
    input.shared_string_arrays.length > 1024
  )
    throw new Error("Invalid historical baseline envelope");
  const arrays: string[][] = [];
  for (const entry of input.shared_string_arrays) {
    if (
      !Array.isArray(entry) ||
      !entry.length ||
      entry.length > 1024 ||
      !entry.every(
        (item: unknown): item is string =>
          typeof item === "string" && Buffer.byteLength(item) <= 8192,
      )
    )
      throw new Error("Invalid historical baseline string array");
    arrays.push(entry);
  }
  let remaining = 100_000;
  const expand = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 64) throw new Error("Historical baseline expansion limit");
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > 8192) throw new Error("Historical baseline string limit");
      return value;
    }
    if (Array.isArray(value)) return value.map((item: unknown) => expand(item, depth + 1));
    if (!isRecord(value)) throw new Error("Invalid historical baseline value");
    if (Object.hasOwn(value, "string_array")) {
      const index = value.string_array;
      if (
        Object.keys(value).length !== 1 ||
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !arrays[index]
      )
        throw new Error("Invalid historical baseline reference");
      // Original JSON arrays were independent objects, even when equal.
      return arrays[index].map((item) => expand(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item, depth + 1)]),
    );
  };
  const result = expand(input.data, 0);
  const serialized = JSON.stringify(result);
  if (
    serialized.length > 2 * 1024 * 1024 ||
    createHash("sha256").update(serialized).digest("hex") !== historicalBaselineSha256
  )
    throw new Error("Historical baseline differs from the independently retained original");
  // This assertion follows validation against the exact original JSON value,
  // including all keys and types; it is not an unchecked fixture cast.
  return result as Expanded<typeof compact.data>;
}

export default decodeDesktopExecutionBaseline(compact);
