import { isRecord } from "./runtime-values.mts";
// Conservatively bind complete maintained helper trees, including all local
// imports, rather than trying to infer a security closure using import regexes.
export const compilerProducerPaths = Object.freeze([
  "scripts",
  "apps/desktop/scripts",
  ".github/workflows/release.yml",
  ".github/actions",
  "apps/desktop/src-tauri/tauri.release-public.conf.json",
  "apps/desktop/package.json",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".node-version",
  ".npmrc",
  ".pnpmfile.cjs",
  "rust-toolchain.toml",
  "Cargo.lock",
  ".cargo",
  "apps/.cargo",
  "apps/desktop/.cargo",
  "apps/desktop/src-tauri/.cargo",
  "crates/.cargo",
  "crates/portcove-cli/.cargo",
] as const);

export interface CompilerSourceClosure {
  schema_version: 1;
  source_commit: string;
  source_tree: string;
  paths: { path: string; entry: { mode: string; type: string; sha: string } | null }[];
}
export function inspectReleaseCompilerSourceClosure(raw: unknown): CompilerSourceClosure {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "paths,schema_version,source_commit,source_tree" ||
    raw.schema_version !== 1 ||
    typeof raw.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.source_commit) ||
    typeof raw.source_tree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.source_tree) ||
    !Array.isArray(raw.paths) ||
    raw.paths.length !== compilerProducerPaths.length
  )
    throw new Error("complete fixed compiler source closure required");
  const paths = raw.paths.map((value: unknown, index) => {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "entry,path" ||
      value.path !== compilerProducerPaths[index]
    )
      throw new Error("compiler source closure inventory differs");
    if (value.entry === null) return { path: compilerProducerPaths[index]!, entry: null };
    const entry = value.entry;
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "mode,sha,type" ||
      !["100644", "100755", "040000"].includes(String(entry.mode)) ||
      entry.type !== (entry.mode === "040000" ? "tree" : "blob") ||
      typeof entry.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(entry.sha)
    )
      throw new Error("compiler source closure entry malformed");
    return {
      path: compilerProducerPaths[index]!,
      entry: { mode: String(entry.mode), type: String(entry.type), sha: entry.sha },
    };
  });
  return {
    schema_version: 1,
    source_commit: raw.source_commit,
    source_tree: raw.source_tree,
    paths,
  };
}
