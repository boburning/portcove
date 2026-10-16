import { parseAllDocuments } from "yaml";

// The packages table owns registry artifacts; snapshots add peer contexts only.
export function lockInventory(text) {
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (!documents.length) throw new Error("Empty pnpm lock");
  const inventory = new Map();
  for (const [index, document] of documents.entries()) {
    if (document.errors.length)
      throw new Error(`Malformed pnpm lock: ${document.errors[0].message}`);
    const lock = document.toJS();
    if (
      String(lock?.lockfileVersion) !== "9.0" ||
      !lock.packages ||
      typeof lock.packages !== "object" ||
      Array.isArray(lock.packages)
    )
      throw new Error("Unsupported pnpm lock schema");
    for (const [key, record] of Object.entries(lock.packages)) {
      const identity = key.match(
        /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\([^\r\n]*\))?$/u,
      );
      const resolution = record?.resolution;
      const supported =
        identity &&
        resolution &&
        typeof resolution.integrity === "string" &&
        /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*$/u.test(resolution.integrity) &&
        Object.keys(resolution).every((field) => field === "integrity");
      inventory.set(
        `${index}:${key}`,
        supported
          ? { name: identity[1], version: identity[2], integrity: resolution.integrity }
          : { unsupported: key, record },
      );
    }
    for (const [importer, sections] of Object.entries(lock.importers ?? {})) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [name, record] of Object.entries(sections?.[section] ?? {})) {
          if (
            [record?.version, record?.specifier].some(
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

export function introducedPackages(base, candidate) {
  const before = lockInventory(base),
    after = lockInventory(candidate);
  const known = new Set(
    [...before.values()]
      .filter((r) => !r.unsupported)
      .map((r) => `${r.name}@${r.version}:${r.integrity}`),
  );
  const changes = new Map();
  for (const [key, record] of after) {
    if (record.unsupported) {
      if (!before.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(record))
        changes.set(key, record);
    } else if (!known.has(`${record.name}@${record.version}:${record.integrity}`))
      changes.set(`${record.name}@${record.version}`, record);
  }
  return [...changes.values()].sort((a, b) =>
    (a.name ?? a.unsupported).localeCompare(b.name ?? b.unsupported),
  );
}
