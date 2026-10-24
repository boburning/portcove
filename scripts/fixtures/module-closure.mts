import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isBuiltin, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { initSync, parse } from "es-module-lexer";

initSync();
const moduleLimit = 1024 * 1024;
const closureLimit = 8 * moduleLimit;

export interface FixtureModule {
  path: string;
  bytes: Buffer;
  sha256: string;
}

/** Read fixture inputs without executing them or changing any provenance allowlist.
 * Entry points must include separately launched programs; package dependencies and
 * runtime-selected files remain the caller's explicit fixture responsibilities.
 */
export function readFixtureModuleClosure(
  root: string,
  entries: readonly string[],
  options: { includeDynamicImports?: boolean } = {},
) {
  root = realpathSync(root);
  if (entries.length === 0) throw new Error("Fixture module closure needs an entry point");
  const pending = entries.map(resolve);
  const modules = new Map<string, FixtureModule>();
  const identities = new Map<string, { dev: bigint; ino: bigint }>();
  const external = new Set<string>();
  let total = 0;
  while (pending.length) {
    const file = pending.pop()!;
    // realpath on Windows can preserve the caller's directory casing.
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    const previous = identities.get(key);
    if (previous) {
      const current = lstatSync(file, { bigint: true });
      if (previous.dev !== current.dev || previous.ino !== current.ino)
        throw new Error(`Fixture module closure has conflicting case aliases: ${file}`);
      continue;
    }
    if (modules.size >= 256) throw new Error("Fixture module closure exceeds 256 files");
    const { bytes, identity } = readModule(file);
    total += bytes.length;
    if (total > closureLimit) throw new Error("Fixture module closure exceeds 8 MiB");
    const relative = path.relative(root, file).split(path.sep).join("/");
    modules.set(key, {
      path: relative,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    identities.set(key, identity);
    const extension = path.extname(file);
    if (extension === ".json") continue;
    if (![".mts", ".ts", ".mjs", ".js"].includes(extension))
      throw new Error(`Fixture module closure requires explicit ESM files: ${relative}`);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const runtime = [".mts", ".ts"].includes(extension)
      ? stripTypeScriptTypes(source, { sourceUrl: file })
      : source;
    for (const specifier of parse(runtime, relative)[0]) {
      if (specifier.d === -2) continue; // import.meta has no dependency.
      if (specifier.d >= 0 && options.includeDynamicImports === false) continue;
      if (specifier.n === undefined)
        throw new Error(`Fixture module closure cannot resolve a computed import: ${relative}`);
      const name = specifier.n;
      if (name.includes("\\"))
        throw new Error(`Fixture module closure requires URL import separators: ${name}`);
      if (name.startsWith("./") || name.startsWith("../")) {
        if (name.includes("?") || name.includes("#") || name.includes("\\") || name.includes("%"))
          throw new Error(`Fixture module closure requires a plain relative import: ${name}`);
        pending.push(resolve(path.relative(root, path.resolve(path.dirname(file), name))));
      } else if (name.startsWith("#")) {
        throw new Error(`Fixture module closure cannot resolve a package import alias: ${name}`);
      } else if (isBuiltin(name) || (!name.includes(":") && !path.isAbsolute(name))) {
        external.add(name);
      } else {
        throw new Error(`Fixture module closure refuses an absolute import: ${name}`);
      }
    }
  }
  return {
    modules: [...modules.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    external: [...external].sort(),
  };

  function resolve(entry: string) {
    if (path.isAbsolute(entry)) throw new Error(`Fixture entry must be relative: ${entry}`);
    const file = path.resolve(root, entry);
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(`Fixture module closure escapes its root: ${entry}`);
    let parent = file;
    while (path.relative(root, parent) !== "") {
      if (lstatSync(parent).isSymbolicLink())
        throw new Error(`Fixture module closure refuses a link: ${parent}`);
      const next = path.dirname(parent);
      if (next === parent)
        throw new Error(`Fixture module closure ancestor escaped its root: ${entry}`);
      parent = next;
    }
    const canonical = realpathSync(file);
    const physical = path.relative(root, canonical);
    if (
      !physical ||
      physical === ".." ||
      physical.startsWith(`..${path.sep}`) ||
      path.isAbsolute(physical)
    )
      throw new Error(`Fixture module closure physical path escapes its root: ${entry}`);
    return canonical;
  }
}

function readModule(file: string) {
  const descriptor = openSync(file, "r");
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile()) throw new Error(`Fixture module is not a file: ${file}`);
    const bytes = Buffer.alloc(moduleLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > moduleLimit) throw new Error(`Fixture module exceeds 1 MiB: ${file}`);
    return {
      bytes: Buffer.from(bytes.subarray(0, length)),
      identity: { dev: metadata.dev, ino: metadata.ino },
    };
  } finally {
    closeSync(descriptor);
  }
}
