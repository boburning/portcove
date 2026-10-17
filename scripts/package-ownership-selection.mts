import { isRecord } from "./runtime-values.mts";
function objectValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid packaging metadata object");
  return value;
}
function assertDependencyEdges(
  entries: Record<string, unknown>,
): asserts entries is Record<string, string> {
  for (const version of Object.values(entries))
    if (typeof version !== "string") throw new Error("invalid packaging dependency version");
}
function dependencyEdges(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const entries = objectValue(value);
  assertDependencyEdges(entries);
  return entries;
}
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const dependencyFiles = new Set(["apps/desktop/package.json", "package.json", "pnpm-lock.yaml"]);
function manifestIdentity(text: string, desktop = false) {
  const value = objectValue(JSON.parse(text));
  if (desktop)
    value.dependencies = Object.fromEntries(
      Object.entries(objectValue(value.dependencies ?? {})).filter(([name]) =>
        name.startsWith("@tauri-apps/"),
      ),
    );
  return value;
}
function lockIdentity(text: string) {
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (!documents.length || documents.some((doc) => doc.errors.length))
    throw new Error("invalid lock");
  return documents.map((document) => lockDocumentIdentity(document.toJS()));
}
function lockDocumentIdentity(rawLock: unknown) {
  const lock = objectValue(rawLock);
  if (lock.lockfileVersion !== "9.0" && lock.lockfileVersion !== 9)
    throw new Error("unknown lock version");
  const { importers, packages, snapshots, ...settings } = lock;
  if (!isRecord(importers) || !isRecord(packages) || !isRecord(snapshots))
    throw new Error("incomplete lock");
  const checkedSnapshots = snapshots;
  const checkedPackages = packages;
  const graph = new Map<string, { snapshot: Record<string, unknown>; package: unknown }>();
  function visit(key: string) {
    if (graph.has(key)) return;
    const packageKey = key.replace(/\(.*$/u, "");
    if (
      !Object.hasOwn(checkedSnapshots, key) ||
      !Object.hasOwn(checkedPackages, packageKey) ||
      !checkedPackages[packageKey]
    )
      throw new Error(`unknown packaging dependency: ${key}`);
    const snapshot = objectValue(checkedSnapshots[key]);
    graph.set(key, { snapshot, package: checkedPackages[packageKey] });
    for (const [name, version] of Object.entries({
      ...dependencyEdges(snapshot.dependencies),
      ...dependencyEdges(snapshot.optionalDependencies),
    }))
      visit(Object.hasOwn(checkedSnapshots, version) ? version : `${name}@${version}`);
  }
  for (const key of Object.keys(snapshots))
    if (/^(?:@tauri-apps\/|vite-plus@)/u.test(key)) visit(key);
  if (![...graph.keys()].some((key: string) => key.startsWith("@tauri-apps/cli@"))) return lock;
  return {
    settings,
    graph: Object.fromEntries(graph),
    importers: Object.fromEntries(
      Object.entries(importers).map(([name, value]) => [
        name,
        Object.fromEntries(
          Object.entries(objectValue(value)).map(([kind, entries]) => [
            kind,
            Object.fromEntries(
              Object.entries(objectValue(entries)).filter(([dep]) =>
                /^(?:@tauri-apps\/|vite-plus$)/u.test(dep),
              ),
            ),
          ]),
        ),
      ]),
    ),
  };
}

export function needsPackageOwnership(
  files: readonly string[],
  before: (file: string) => string,
  after: (file: string) => string,
) {
  try {
    if (!files.length || files.some((file) => !dependencyFiles.has(file))) return true;
    for (const file of files) {
      const identity =
        file === "pnpm-lock.yaml"
          ? lockIdentity
          : (text: string) => manifestIdentity(text, file.startsWith("apps/"));
      if (!isDeepStrictEqual(identity(before(file)), identity(after(file)))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args: readonly string[]) =>
    execFileSync("git", args, { encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  let needed = true;
  try {
    const base = process.env.PORTCOVE_BASE_SHA,
      head = process.env.PORTCOVE_HEAD_SHA;
    if (
      base === undefined ||
      head === undefined ||
      !/^[a-f0-9]{40}$/u.test(base) ||
      !/^[a-f0-9]{40}$/u.test(head)
    )
      throw new Error("missing source");
    const files = git(["diff", "--name-only", "-z", "--no-renames", base, head])
      .split("\0")
      .filter(Boolean);
    needed = needsPackageOwnership(
      files,
      (file) => git(["show", `${base}:${file}`]),
      (file) => git(["show", `${head}:${file}`]),
    );
  } catch {
    /* Safe uncertainty retains rehearsal. */
  }
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(output, `needed=${needed}\n`);
  console.log(
    needed
      ? "Packaging inputs changed or uncertain: rehearse ownership."
      : "Frontend dependency change leaves packaging inputs unchanged.",
  );
}
