/** Maintained source declarations only. These are not native runtime observations
 * and cannot establish producer, compiler, compatibility or acceptance authority. */
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
export const nativeCompatibilitySourcePaths = Object.freeze([
  "crates/portcove-core/src/lib.rs",
  "crates/portcove-core/src/database.rs",
  "crates/portcove-core/catalog/catalog.json",
] as const);

// Must equal Core's signed_catalog::MAX_CATALOG_BYTES, the supported bound for
// the generated catalog. Release tools run without reading Core sources;
// release-native-source-contract.test.mts reads Core's constant and checks it.
export const nativeCatalogDeclarationByteLimit = 16 * 1024 * 1024;

export function nativeSourceDeclarationByteLimit(
  pathname: (typeof nativeCompatibilitySourcePaths)[number],
) {
  // The generated catalog shares the supported generated-catalog bound. Rust
  // source declarations retain their narrower limit as the catalog grows.
  return pathname === nativeCompatibilitySourcePaths[2]
    ? nativeCatalogDeclarationByteLimit
    : 1024 * 1024;
}

// Fixed JSON fields of a Git blob response around its content: sha, node_id,
// size, url and encoding. Generous against the few hundred bytes they use.
const nativeSourceBlobEnvelopeBytes = 64 * 1024;

/** Largest Git blob API response for a declaration at its byte limit. The
 * content is base64 (4 bytes per 3, padded), wrapped every 60 characters, and
 * each newline is JSON-escaped as two bytes; the envelope adds fixed fields. */
export function nativeSourceBlobResponseByteLimit(
  pathname: (typeof nativeCompatibilitySourcePaths)[number],
) {
  const base64 = 4 * Math.ceil(nativeSourceDeclarationByteLimit(pathname) / 3);
  return base64 + 2 * Math.ceil(base64 / 60) + nativeSourceBlobEnvelopeBytes;
}

/** Response bound for a reader dedicated to declaration blobs: the largest
 * declaration's blob. Every release reader of declaration blobs uses this, and
 * keeps its other reads on their own bounds. */
export const nativeSourceBlobReadByteLimit = Math.max(
  ...nativeCompatibilitySourcePaths.map(nativeSourceBlobResponseByteLimit),
);

export function readCliApiDeclaration(source: string): number {
  const matches = [
    ...source.matchAll(/^pub const API_SCHEMA_VERSION: u32 = ([1-9][0-9]{0,8});\r?$/gmu),
  ];
  const value = matches[0]?.[1];
  if (matches.length !== 1 || value === undefined)
    throw new Error("native CLI API declaration is absent or ambiguous");
  return Number(value);
}

export function inspectNativeCompatibilitySources(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== [...nativeCompatibilitySourcePaths].sort().join(",")
  )
    throw new Error("native source declaration inventory differs");
  const files = nativeCompatibilitySourcePaths.map((path) => {
    const bytes = raw[path];
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > nativeSourceDeclarationByteLimit(path)
    )
      throw new Error("native source declaration bytes are missing or oversized");
    return {
      path,
      bytes: Buffer.from(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const text = (path: string) =>
    new TextDecoder("utf-8", { fatal: true }).decode(
      files.find((file) => file.path === path)!.bytes,
    );
  const lib = text(nativeCompatibilitySourcePaths[0]),
    database = text(nativeCompatibilitySourcePaths[1]);
  const constant = (source: string, expression: RegExp) => {
    const matches = [...source.matchAll(expression)];
    if (matches.length !== 1 || !matches[0]?.[1])
      throw new Error("native source declaration is absent or ambiguous");
    return matches[0][1];
  };
  const integer = (value: string) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1)
      throw new Error("native source protocol declaration is invalid");
    return result;
  };
  const api = readCliApiDeclaration(lib);
  const minimum = integer(
    constant(lib, /^pub const MIN_LIBRARY_SCHEMA_VERSION: u32 = ([1-9][0-9]{0,8});\r?$/gmu),
  );
  const current = integer(
    constant(
      database,
      /^pub\(crate\) const CURRENT_SCHEMA_VERSION: i64 = ([1-9][0-9]{0,8});\r?$/gmu,
    ),
  );
  const lock = constant(
    lib,
    /^pub const APPLICATION_UPDATE_LOCK_PROTOCOL: &str = "([A-Za-z0-9._-]{1,128})";\r?$/gmu,
  );
  if (
    !/^pub const LIBRARY_SCHEMA_VERSION: u32 = database::CURRENT_SCHEMA_VERSION as u32;\r?$/mu.test(
      lib,
    ) ||
    minimum > current
  )
    throw new Error("native library version declaration is unavailable");
  const catalog: unknown = JSON.parse(text(nativeCompatibilitySourcePaths[2]));
  if (
    !isRecord(catalog) ||
    typeof catalog.schema_version !== "number" ||
    ![1, 2, 3].includes(catalog.schema_version)
  )
    throw new Error("native embedded catalog declaration is unsupported");
  // The retired application updater's Windows installed-context declaration was
  // the fourth input; it was removed with that updater under the #534 decision.
  return Object.freeze({
    cli_protocol: Object.freeze({ min: api, max: api }),
    catalog_formats: Object.freeze([catalog.schema_version]),
    library: Object.freeze({
      read: Object.freeze({ min: minimum, max: current }),
      write_schema: current,
      lock_protocol: lock,
    }),
    available_capabilities: Object.freeze([lock]),
    files: Object.freeze(
      files.map(({ path, sha256, bytes }) =>
        Object.freeze({ path, sha256, bytes: bytes.byteLength }),
      ),
    ),
    authority: "none" as const,
    scope:
      "maintained source declarations only; runtime and acceptance independently required" as const,
  });
}
