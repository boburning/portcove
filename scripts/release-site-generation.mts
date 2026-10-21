/** Whole-site byte provenance only. A marker never appoints a TUF root or
 * authorizes either component. Expected generations come from the existing
 * protected coordinator and each component keeps its independent verifier. */
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";

export interface SiteFileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}
export type SiteGeneration = {
  previous_generation: string | null;
  files: SiteFileIdentity[];
  generation: string;
} & (
  | { schema_version: 1; application_root_sha256: string }
  | {
      schema_version: 2;
      application_root_sha256: string | null;
      catalog_root_sha256: string | null;
    }
);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export const isSafeSitePath = (name: string) =>
  name === ".nojekyll" ||
  (name.length <= 512 &&
    name.split("/").length <= 16 &&
    name
      .split("/")
      .every(
        (segment) =>
          /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(segment) && segment !== "." && segment !== "..",
      ));

export function inspectSiteGeneration(raw: unknown, expected: string): SiteGeneration {
  if (!isRecord(raw) || !digest(expected)) throw new Error("site generation unavailable");
  const two = raw.schema_version === 2;
  if (
    Object.keys(raw).sort().join(",") !==
      (two
        ? "application_root_sha256,catalog_root_sha256,files,generation,previous_generation,schema_version"
        : "application_root_sha256,files,generation,previous_generation,schema_version") ||
    (!two && raw.schema_version !== 1) ||
    raw.generation !== expected ||
    !(raw.previous_generation === null || digest(raw.previous_generation)) ||
    !(digest(raw.application_root_sha256) || (two && raw.application_root_sha256 === null)) ||
    (two && !(raw.catalog_root_sha256 === null || digest(raw.catalog_root_sha256))) ||
    (two && raw.application_root_sha256 === null && raw.catalog_root_sha256 === null) ||
    (two &&
      raw.application_root_sha256 !== null &&
      raw.application_root_sha256 === raw.catalog_root_sha256) ||
    !Array.isArray(raw.files) ||
    raw.files.length > 6000
  )
    throw new Error("site generation schema differs");
  const seen = new Set<string>();
  let total = 0;
  const files = raw.files.map((file: unknown): SiteFileIdentity => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      typeof file.path !== "string" ||
      !isSafeSitePath(file.path) ||
      !/^(?:\.nojekyll$|(?:application\/(?:metadata|targets)|catalog)\/)/u.test(file.path) ||
      seen.has(file.path) ||
      !digest(file.sha256) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 64 * 1024 * 1024
    )
      throw new Error("site generation file identity differs");
    seen.add(file.path);
    total += file.bytes;
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (
    total > 256 * 1024 * 1024 ||
    !seen.has(".nojekyll") ||
    (raw.application_root_sha256 !== null && !seen.has("application/metadata/timestamp.json")) ||
    (two && raw.catalog_root_sha256 !== null && !seen.has("catalog/metadata/timestamp.json")) ||
    JSON.stringify(files.map((file) => file.path)) !== JSON.stringify([...seen].sort())
  )
    throw new Error("site generation inventory differs");
  const body = two
    ? {
        schema_version: 2 as const,
        previous_generation: raw.previous_generation,
        application_root_sha256: raw.application_root_sha256,
        catalog_root_sha256: raw.catalog_root_sha256 as string | null,
        files,
      }
    : {
        schema_version: 1 as const,
        previous_generation: raw.previous_generation,
        application_root_sha256: raw.application_root_sha256 as string,
        files,
      };
  if (capacityDigest(body) !== expected) throw new Error("site generation digest differs");
  return { ...body, generation: expected };
}
