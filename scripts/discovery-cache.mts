import { readFileSync, lstatSync, copyFileSync, constants } from "node:fs";
import { isRecord, errorCode } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import type { InventoryCache } from "./roadmap-inventory.mts";
export function isDiscoveryCache(value: unknown): value is InventoryCache {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.repository !== "string" ||
    typeof value.repository_node_id !== "string" ||
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    !Array.isArray(value.issues)
  )
    return false;
  const ids = new Set<string>();
  for (const raw of value.issues as unknown[]) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !raw.id ||
      ids.has(raw.id) ||
      typeof raw.number !== "number" ||
      !Number.isSafeInteger(raw.number) ||
      raw.number < 1 ||
      typeof raw.url !== "string" ||
      typeof raw.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.updatedAt)) ||
      typeof raw.body !== "string" ||
      raw.body_sha256 !== observationHash(raw.body)
    )
      return false;
    ids.add(raw.id);
  }
  return true;
}
/** Read-only planning ignores invalid cache data; a locked run preserves its bytes. */
export function readDiscoveryCache(file: string, preserveAs?: string): InventoryCache | undefined {
  let size: number;
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Inventory cache must be an owned regular file");
    size = info.size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (size > 128 * 1024 * 1024)
    throw new Error("Oversized inventory cache retained in place; reconcile before rebuild");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (isDiscoveryCache(value)) return value;
  if (preserveAs) copyFileSync(file, preserveAs, constants.COPYFILE_EXCL);
  return undefined;
}
