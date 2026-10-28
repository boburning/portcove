import { isRecord } from "./runtime-values.mts";
type PackageIdentity =
  | { name: string; version: string; integrity: string; unsupported?: never; record?: never }
  | { unsupported: string; record: unknown; name?: never; version?: never; integrity?: never };
function entries(value: unknown): [string, unknown][] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) throw new Error("Malformed pnpm lock table");
  return Object.entries(value);
}
import { parseAllDocuments, parseDocument } from "yaml";

// A root-workspace authority check, separate from the generic comparison inventory.
// pnpm's env document also records optional binaries for platforms other than this host.
export function validateRootPnpmToolchain(text: string, packageManager: string, workspace: string) {
  const version = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageManager)?.[1];
  if (!version) throw new Error("Root packageManager must pin an exact pnpm version");
  const configuration = parseDocument(workspace, { uniqueKeys: true });
  const settings: unknown = configuration.toJS();
  if (
    configuration.errors.length ||
    configuration.warnings.length ||
    !isRecord(settings) ||
    settings.pmOnFail !== "error" ||
    settings.runtimeOnFail !== "ignore"
  )
    throw new Error("Provider-owned pnpm must enforce its pin without runtime downloads");
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (documents.length !== 2 || documents.some((d) => d.errors.length || d.warnings.length))
    throw new Error("Root pnpm lock requires one toolchain document and one application document");
  // Keep the existing schema/source inventory checks for both documents.
  lockInventory(text);
  const env: unknown = documents[0]?.toJS(),
    application: unknown = documents[1]?.toJS();
  const table = (value: unknown, label: string): Record<string, unknown> => {
    if (!isRecord(value)) throw new Error(`Missing pnpm toolchain ${label}`);
    return value;
  };
  const environment = table(env, "document"),
    app = table(application, "application document");
  const importer = table(table(environment.importers, "importers")["."], "root importer");
  const managers = table(importer.packageManagerDependencies, "package-manager pin");
  const pin = table(managers.pnpm, "pnpm pin");
  if (
    Object.keys(managers).join() !== "pnpm" ||
    pin.specifier !== version ||
    pin.version !== version
  )
    throw new Error("Toolchain lock does not match the root pnpm pin");
  const appImporter = table(table(app.importers, "application importers")["."], "application root");
  if (appImporter.packageManagerDependencies !== undefined)
    throw new Error("Duplicate pnpm toolchain authority in application document");
  const packages = table(environment.packages, "artifacts"),
    snapshots = table(environment.snapshots, "snapshots");
  const start = `pnpm@${version}`,
    pending = [start],
    visited = new Set<string>();
  while (pending.length) {
    const identity = pending.pop();
    if (identity === undefined) break;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const artifact = table(packages[identity], "artifact"),
      resolution = table(artifact.resolution, "resolution");
    const integrity = resolution.integrity;
    const encoded =
      typeof integrity === "string" && /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity)?.[1];
    if (
      !encoded ||
      Object.keys(resolution).join() !== "integrity" ||
      Buffer.from(encoded, "base64").length !== 64 ||
      Buffer.from(encoded, "base64").toString("base64") !== encoded
    )
      throw new Error("Missing or unsupported pnpm toolchain artifact integrity");
    const snapshot = table(snapshots[identity], "snapshot");
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, resolved] of entries(snapshot[section])) {
        if (!/^@pnpm\/exe\.[a-z0-9-]+$/u.test(name) || resolved !== version)
          throw new Error("Unsupported pnpm toolchain dependency closure");
        pending.push(`${name}@${resolved}`);
      }
    }
  }
  if (
    Object.keys(packages).length !== visited.size ||
    Object.keys(snapshots).length !== visited.size
  )
    throw new Error("Orphaned or incomplete pnpm toolchain integrity closure");
  const optional = table(
    table(snapshots[start], "pnpm snapshot").optionalDependencies,
    "platform dependencies",
  );
  for (const platform of [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ])
    if (optional[`@pnpm/exe.${platform}`] !== version)
      throw new Error(`Missing maintained pnpm platform: ${platform}`);
  return { version, artifacts: visited.size };
}

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
