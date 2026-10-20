import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
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

/** Generated only during the existing guarded bootstrap. Its serialized bytes
 * acquire trust only inside that existing authenticated tool artifact/manifest. */
export async function prepareReleaseCompilerSourceClosure(
  sourceRoot: string,
  expected: { source_commit: string; source_tree: string },
): Promise<CompilerSourceClosure> {
  if (
    !/^[a-f0-9]{40}$/u.test(expected.source_commit) ||
    !/^[a-f0-9]{40}$/u.test(expected.source_tree)
  )
    throw new Error("fixed bootstrap source identity unavailable");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", sourceRoot, ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        },
      },
    );
  const guard = () => {
    if (
      git(["rev-parse", "HEAD"]).trim() !== expected.source_commit ||
      git(["rev-parse", "HEAD^{tree}"]).trim() !== expected.source_tree ||
      git(["status", "--porcelain=v1", "--untracked-files=no"]).trim()
    )
      throw new Error("fixed bootstrap compiler source changed or is dirty");
  };
  guard();
  const entries = new Map<string, { mode: string; type: string; sha: string }>();
  for (const value of git(["ls-tree", "-z", expected.source_commit, "--", ...compilerProducerPaths])
    .split("\0")
    .filter(Boolean)) {
    const parsed = /^(100644|100755|040000) (blob|tree) ([a-f0-9]{40})\t([^\0]+)$/u.exec(value);
    if (!parsed) throw new Error("fixed compiler source includes unsupported Git entry");
    entries.set(parsed[4]!, { mode: parsed[1]!, type: parsed[2]!, sha: parsed[3]! });
  }
  guard();
  return inspectReleaseCompilerSourceClosure({
    schema_version: 1,
    ...expected,
    paths: compilerProducerPaths.map((filename) => ({
      path: filename,
      entry: entries.get(filename) ?? null,
    })),
  });
}

/** Authenticated source equality is one necessary compiler condition. This
 * does not authenticate execution, outputs, compatibility or native behavior.
 * The fixed controller chooses this inventory; candidate files are never run. */
export async function compareReleaseCompilerSource(
  trustedRoot: string,
  candidateTree: string,
  options: { api?: GitHubRestReader } = {},
) {
  if (!/^[a-f0-9]{40}$/u.test(candidateTree))
    throw new Error("compiler source tree identity unavailable");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", trustedRoot, ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        },
      },
    );
  const controllerCommit = git(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(controllerCommit))
    throw new Error("fixed controller revision unavailable");
  const closure = await prepareReleaseCompilerSourceClosure(trustedRoot, {
    source_commit: controllerCommit,
    source_tree: git(["rev-parse", "HEAD^{tree}"]).trim(),
  });
  const local = new Map(closure.paths.map((entry) => [entry.path, entry.entry]));
  const runner = createGitHubRunner({
    cwd: trustedRoot,
    maxBuffer: 2 * 1024 * 1024,
    timeoutMs: 15000,
    spawn: (command, args, settings) =>
      spawnSync(command, args, { ...settings, env: { ...process.env, GH_HOST: "github.com" } }),
  });
  const api =
    options.api ??
    new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
  const trees = new Map<string, Map<string, { mode: string; type: string; sha: string }>>();
  let requests = 0;
  const readTree = (sha: string) => {
    const cached = trees.get(sha);
    if (cached) return cached;
    if (++requests > 32) throw new Error("compiler source tree request bound exhausted");
    const response = api.request("GET", `repos/boburning/portcove/git/trees/${sha}`);
    const body = response.body;
    if (
      response.status !== 200 ||
      !isRecord(body) ||
      body.sha !== sha ||
      body.truncated !== false ||
      !Array.isArray(body.tree) ||
      body.tree.length > 2000
    )
      throw new Error("complete authenticated compiler source tree unavailable");
    const entries = new Map<string, { mode: string; type: string; sha: string }>();
    for (const raw of body.tree) {
      if (
        !isRecord(raw) ||
        typeof raw.path !== "string" ||
        !raw.path ||
        raw.path.length > 256 ||
        /[\\/\0\r\n]/u.test(raw.path) ||
        entries.has(raw.path) ||
        typeof raw.mode !== "string" ||
        typeof raw.type !== "string" ||
        typeof raw.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(raw.sha)
      )
        throw new Error("compiler Git tree entry is malformed or duplicated");
      entries.set(raw.path, { mode: raw.mode, type: raw.type, sha: raw.sha });
    }
    trees.set(sha, entries);
    return entries;
  };
  const observed = compilerProducerPaths.map((filename) => {
    let tree = candidateTree;
    let found: { mode: string; type: string; sha: string } | undefined;
    const parts = filename.split("/");
    for (const [index, part] of parts.entries()) {
      found = readTree(tree).get(part);
      if (!found) break;
      if (index < parts.length - 1) {
        if (found.type !== "tree" || found.mode !== "040000")
          throw new Error("compiler source ancestor is not a normal Git tree");
        tree = found.sha;
      }
    }
    const expected = local.get(filename);
    if (JSON.stringify(expected ?? null) !== JSON.stringify(found ?? null))
      throw new Error(`candidate compiler workflow/helper/configuration differs: ${filename}`);
    return { path: filename, ...(found ?? { absent: true }) };
  });
  if (git(["rev-parse", "HEAD"]).trim() !== controllerCommit)
    throw new Error("fixed controller changed during compiler source comparison");
  return Object.freeze({
    evidence_scope: options.api ? "injected-provider" : "github.com",
    authority: "none",
    controller_commit: controllerCommit,
    candidate_tree: candidateTree,
    closure_sha256: createHash("sha256").update(JSON.stringify(observed)).digest("hex"),
    paths: Object.freeze(observed),
    scope: "exact producing workflow and conservative maintained helper/configuration closure only",
  });
}
