import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

/** Existing coordinator/capacity JSON identity encoding. This is a digest, not authentication. */
export function releaseCanonicalDigest(value: unknown): string {
  const ordered = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(ordered)
      : isRecord(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, ordered(entry[key])]),
          )
        : entry;
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
