import { isRecord } from "./runtime-values.mts";
type PackageIdentity =
  | { name: string; version: string; integrity: string; unsupported?: never; record?: never }
  | { unsupported: string; record: unknown; name?: never; version?: never; integrity?: never };
function entries(value: unknown): [string, unknown][] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) throw new Error("Malformed pnpm lock table");
  return Object.entries(value);
}
import { parseAllDocuments } from "yaml";

// The packages table owns registry artifacts; snapshots add peer contexts only.
export function lockInventory(text: string) {
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (!documents.length) throw new Error("Empty pnpm lock");
  const inventory = new Map<string, PackageIdentity>();
  for (const [index, document] of documents.entries()) {
    if (document.errors.length)
      throw new Error(
        `Malformed pnpm lock: ${document.errors[0]?.message ?? "unknown YAML error"}`,
      );
    const lock: unknown = document.toJS();
    if (
      !isRecord(lock) ||
      String(lock.lockfileVersion) !== "9.0" ||
      !lock.packages ||
      typeof lock.packages !== "object" ||
      Array.isArray(lock.packages)
    )
      throw new Error("Unsupported pnpm lock schema");
    for (const [key, record] of entries(lock.packages)) {
      const identity = key.match(
        /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\([^\r\n]*\))?$/u,
      );
      const resolution = isRecord(record) ? record.resolution : undefined;
      const integrity =
        isRecord(resolution) && typeof resolution.integrity === "string"
          ? resolution.integrity
          : undefined;
      const name = identity?.[1],
        version = identity?.[2];
      const supported =
        name !== undefined &&
        version !== undefined &&
        integrity !== undefined &&
        isRecord(resolution) &&
        typeof resolution.integrity === "string" &&
        /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*$/u.test(resolution.integrity) &&
        Object.keys(resolution).every((field) => field === "integrity");
      inventory.set(
        `${index}:${key}`,
        supported ? { name, version, integrity } : { unsupported: key, record },
      );
    }
    for (const [importer, sections] of entries(lock.importers)) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [name, record] of entries(isRecord(sections) ? sections[section] : undefined)) {
          if (
            [
              isRecord(record) ? record.version : undefined,
              isRecord(record) ? record.specifier : undefined,
            ].some(
              (value) =>
                typeof value === "string" &&
                /^(?:link:|file:|workspace:|git(?:\+|:)|https?:|github:|gitlab:|bitbucket:)/u.test(
                  value,
                ),
            )
          ) {
            const key = `${index}:importer:${importer}:${section}:${name}`;
            inventory.set(key, { unsupported: key, record });
          }
        }
      }
    }
  }
  return inventory;
}

export function introducedPackages(base: string, candidate: string) {
  const before = lockInventory(base),
    after = lockInventory(candidate);
  const known = new Set(
    [...before.values()]
      .filter((r) => r.unsupported === undefined)
      .map((r) => `${r.name}@${r.version}:${r.integrity}`),
  );
  const changes = new Map<string, PackageIdentity>();
  for (const [key, record] of after) {
    if (record.unsupported !== undefined) {
      if (!before.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(record))
        changes.set(key, record);
    } else if (!known.has(`${record.name}@${record.version}:${record.integrity}`))
      changes.set(`${record.name}@${record.version}`, record);
  }
  return [...changes.values()].sort((a, b) =>
    (a.name ?? a.unsupported).localeCompare(b.name ?? b.unsupported),
  );
}
