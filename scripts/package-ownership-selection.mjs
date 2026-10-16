import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const dependencyFiles = new Set(["apps/desktop/package.json", "package.json", "pnpm-lock.yaml"]);
function manifestIdentity(text, desktop = false) {
  const value = JSON.parse(text);
  if (desktop)
    value.dependencies = Object.fromEntries(
      Object.entries(value.dependencies ?? {}).filter(([name]) => name.startsWith("@tauri-apps/")),
    );
  return value;
}
function lockIdentity(text) {
  const documents = parseAllDocuments(text, { uniqueKeys: true });
  if (!documents.length || documents.some((doc) => doc.errors.length))
    throw new Error("invalid lock");
  return documents.map((document) => lockDocumentIdentity(document.toJS()));
}
function lockDocumentIdentity(lock) {
  if (lock.lockfileVersion !== "9.0" && lock.lockfileVersion !== 9)
    throw new Error("unknown lock version");
  const { importers, packages, snapshots, ...settings } = lock;
  if (!importers || !packages || !snapshots) throw new Error("incomplete lock");
  const graph = {};
  function visit(key) {
    if (graph[key]) return;
    const snapshot = snapshots[key];
    const packageKey = key.replace(/\(.*$/u, "");
    if (!snapshot || !packages[packageKey]) throw new Error(`unknown packaging dependency: ${key}`);
    graph[key] = { snapshot, package: packages[packageKey] };
    for (const [name, version] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    }))
      visit(snapshots[version] ? version : `${name}@${version}`);
  }
  for (const key of Object.keys(snapshots))
    if (/^(?:@tauri-apps\/|vite-plus@)/u.test(key)) visit(key);
  if (!Object.keys(graph).some((key) => key.startsWith("@tauri-apps/cli@"))) return lock;
  return {
    settings,
    graph,
    importers: Object.fromEntries(
      Object.entries(importers).map(([name, value]) => [
        name,
        Object.fromEntries(
          Object.entries(value).map(([kind, entries]) => [
            kind,
            Object.fromEntries(
              Object.entries(entries).filter(([dep]) => /^(?:@tauri-apps\/|vite-plus$)/u.test(dep)),
            ),
          ]),
        ),
      ]),
    ),
  };
}

export function needsPackageOwnership(files, before, after) {
  try {
    if (!files.length || files.some((file) => !dependencyFiles.has(file))) return true;
    for (const file of files) {
      const identity =
        file === "pnpm-lock.yaml"
          ? lockIdentity
          : (text) => manifestIdentity(text, file.startsWith("apps/"));
      if (!isDeepStrictEqual(identity(before(file)), identity(after(file)))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  let needed = true;
  try {
    const base = process.env.PORTCOVE_BASE_SHA,
      head = process.env.PORTCOVE_HEAD_SHA;
    if (!/^[a-f0-9]{40}$/u.test(base ?? "") || !/^[a-f0-9]{40}$/u.test(head ?? ""))
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
  appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  console.log(
    needed
      ? "Packaging inputs changed or uncertain: rehearse ownership."
      : "Frontend dependency change leaves packaging inputs unchanged.",
  );
}
