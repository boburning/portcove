/** Maintained source declarations only. These are not native runtime observations
 * and cannot establish producer, compiler, compatibility or acceptance authority. */
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
export const nativeCompatibilitySourcePaths = Object.freeze([
  "crates/portcove-core/src/lib.rs",
  "crates/portcove-core/src/database.rs",
  "crates/portcove-core/catalog/catalog.json",
  "apps/desktop/src-tauri/src/application_update_windows.rs",
] as const);

export function inspectNativeCompatibilitySources(raw: unknown) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== [...nativeCompatibilitySourcePaths].sort().join(",")
  )
    throw new Error("native source declaration inventory differs");
  const files = nativeCompatibilitySourcePaths.map((path) => {
    const bytes = raw[path];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024)
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
  const api = integer(
    constant(lib, /^pub const API_SCHEMA_VERSION: u32 = ([1-9][0-9]{0,8});\r?$/gmu),
  );
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
    ![1, 2].includes(catalog.schema_version)
  )
    throw new Error("native embedded catalog declaration is unsupported");
  const windows = text(nativeCompatibilitySourcePaths[3]);
  // Refuse an unfamiliar recipe. This is a source declaration, not an attempt
  // to interpret arbitrary Rust or to infer runtime execution from a pattern.
  for (const literal of [
    "cli_protocol: portcove_core::API_SCHEMA_VERSION,",
    "library_schema: portcove_core::MIN_LIBRARY_SCHEMA_VERSION,",
    "library_write_schema: portcove_core::LIBRARY_SCHEMA_VERSION,",
    "lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.into(),",
    "capabilities: BTreeSet::from([portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.to_owned()]),",
  ])
    if (windows.split(literal).length !== 2)
      throw new Error("maintained Windows context declaration changed");
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
