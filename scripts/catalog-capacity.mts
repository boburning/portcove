/** Offline capacity diagnostics only. No signature, provider read or admission. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "./runtime-values.mts";

export function capacityConstant(source: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [
    ...source.matchAll(new RegExp(`const ${escaped}: (?:usize|u64|i64) = ([0-9 *]+);`, "gu")),
  ];
  if (matches.length !== 1) throw new Error(`Capacity authority missing or ambiguous: ${name}`);
  const parts = matches[0]![1]!.split("*").map((part) => Number(part.trim()));
  const value = parts.reduce((product, part) => product * part, 1);
  if (
    parts.some((part) => !Number.isSafeInteger(part) || part <= 0) ||
    !Number.isSafeInteger(value)
  )
    throw new Error(`Invalid bounded capacity authority: ${name}`);
  return value;
}

function boundedInput(filename: string, limit: number) {
  const entry = lstatSync(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit)
    throw new Error("Capacity input must be a bounded regular catalog file");
  const fd = openSync(filename, "r");
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.size > limit
    )
      throw new Error("Capacity input identity changed");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
      if (length > before.size) throw new Error("Capacity input grew while being read");
      if (!count) break;
    }
    const after = fstatSync(fd);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Capacity input changed while being read");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function catalogCapacity(catalog: unknown, limit: number, issuedAt: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(issuedAt + 86400) ||
    issuedAt < 0
  )
    throw new Error("Capacity diagnostics require finite safe byte and clock inputs");
  if (!isRecord(catalog) || !Array.isArray(catalog.ports))
    throw new Error("Capacity diagnostics require unique declared port identities");
  const ports: unknown[] = catalog.ports;
  const ids = ports.map((port) => {
    if (!isRecord(port) || typeof port.id !== "string")
      throw new Error("Capacity diagnostics require unique declared port identities");
    return port.id;
  });
  if (new Set(ids).size !== ports.length)
    throw new Error("Capacity diagnostics require unique declared port identities");
  const compact = JSON.stringify(catalog);
  const envelopeBytes = (document: unknown) =>
    Buffer.byteLength(
      JSON.stringify({
        format_version: 1,
        key_id: "0".repeat(64),
        payload: JSON.stringify({
          sequence: Number.MAX_SAFE_INTEGER,
          issued_at: issuedAt,
          expires_at: issuedAt + 86400,
          catalog: document,
        }),
        signature: "0".repeat(128),
      }),
    );
  const envelope = envelopeBytes(catalog);
  const shared = envelopeBytes({ ...catalog, ports: [] });
  const portBytes = envelope - shared;
  const average = ports.length ? portBytes / ports.length : null;
  return {
    format: 1,
    authority: "offline-capacity-diagnostic-only",
    catalog_ports: ports.length,
    compact_catalog_bytes: Buffer.byteLength(compact),
    representative_envelope_bytes: envelope,
    envelope_limit_bytes: limit,
    envelope_remaining_bytes: Math.max(0, limit - envelope),
    fits_representative_envelope: envelope <= limit,
    shared_envelope_bytes_with_no_ports: shared,
    average_escaped_port_bytes: average,
    modeled_additional_ports: average
      ? Math.max(0, Math.floor((limit - envelope) / average))
      : null,
    model_assumptions:
      "Current average escaped per-port metadata and fixed shared source data; not a capacity guarantee for future identities or a semantically validated catalog.",
    representative_payload: {
      sequence: Number.MAX_SAFE_INTEGER,
      issued_at: issuedAt,
      expires_at: issuedAt + 86400,
    },
    signature_status: "not-created; fixed-width placeholder counted only",
    catalog_validation: "not-performed; use the existing Core proposal inspector",
    live_cache_occupancy: "Unknown",
    actual_provider_traffic: "Unknown",
    process_memory: "Unknown; serialized byte sizes are not heap/RSS measurements",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { catalog: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help)
    process.stdout.write(
      "Usage: node scripts/catalog-capacity.mts --catalog FILE\nOffline byte/headroom diagnostics; no signing, provider access or admission.\n",
    );
  else {
    if (!values.catalog) throw new Error("--catalog is required");
    const limit = capacityConstant(
      readFileSync(
        new URL("../crates/portcove-core/src/signed_catalog.rs", import.meta.url),
        "utf8",
      ),
      "MAX_CATALOG_BYTES",
    );
    const library = readFileSync(
      new URL("../crates/portcove-core/src/library.rs", import.meta.url),
      "utf8",
    );
    const bytes = boundedInput(values.catalog, limit);
    const report = catalogCapacity(
      JSON.parse(bytes.toString("utf8")),
      limit,
      Math.floor(Date.now() / 1000),
    );
    process.stdout.write(
      JSON.stringify(
        {
          ...report,
          source_bytes: bytes.length,
          source_sha256: createHash("sha256").update(bytes).digest("hex"),
          cache_policy: {
            charged_record_budget_bytes: capacityConstant(library, "HTTP_CACHE_MAX_RECORD_BYTES"),
            per_record_reserve_bytes: capacityConstant(library, "HTTP_CACHE_RECORD_RESERVE_BYTES"),
            retention_seconds: capacityConstant(library, "HTTP_CACHE_MAX_AGE_SECONDS"),
            basis:
              "UTF-8 bodies + twice URL bytes for key/index + validators + per-row reserve; finite budget, no catalog-size-derived row ceiling. Database-file and process sizes are separate observations.",
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
}
