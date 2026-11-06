import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import type { GitHubMetadataResponse } from "./github-operation.mts";
import type { GitHubCredential, GitHubRequestPolicy } from "./github-client.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseSourceChangeRequests, type ReleaseSourceRead } from "./release-source-changes.mts";
import {
  preparationSourcePaths,
  reproducePreparedReleaseVersionFiles,
} from "../apps/desktop/scripts/prepare-release-version.mts";
import { parseWorkspacePackage } from "./check-release-metadata.mts";
import { inspectRemoteGitObject } from "./release-coordinator-recovery.mts";

import {
  compilerProducerPaths,
  inspectReleaseCompilerSourceClosure,
} from "./release-compiler-source-closure.mts";
import type { CompilerSourceClosure } from "./release-compiler-source-closure.mts";
export {
  compilerProducerPaths,
  inspectReleaseCompilerSourceClosure,
} from "./release-compiler-source-closure.mts";
export type { CompilerSourceClosure } from "./release-compiler-source-closure.mts";

/** Generated only during the existing guarded bootstrap. Its serialized bytes
 * acquire trust only inside that existing authenticated tool artifact/manifest. */
export async function prepareReleaseCompilerSourceClosure(
  sourceRoot: string,
  expected: { source_commit: string; source_tree: string },
  options: { git?: string } = {},
): Promise<CompilerSourceClosure> {
  if (
    !/^[a-f0-9]{40}$/u.test(expected.source_commit) ||
    !/^[a-f0-9]{40}$/u.test(expected.source_tree)
  )
    throw new Error("fixed bootstrap source identity unavailable");
  const executable = options.git ?? "git";
  if (options.git !== undefined && !path.isAbsolute(executable))
    throw new Error("fixed compiler closure Git path must be absolute");
  const git = (args: string[]) =>
    execFileSync(
      executable,
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

type CompilerTreeReader = (sha: string) => Promise<unknown>;
const compilerTreeRequestLimit = 32;
const compilerTreeTimeoutMs = 15_000;

/** Sequential reader for the compiler's validated exact endpoints. */
export async function createCompilerSourceReader(options: {
  credential: GitHubCredential;
  deadline: number;
  maxBytes: number;
  fixedReader?: boolean;
  checkSource?: (url: URL) => void;
}) {
  const { createGitHubClient } = await import("./github-client.mts");
  let allowed: string | undefined;
  const client = await createGitHubClient({
    credential: options.credential,
    deadline: options.deadline,
    maxBytes: options.maxBytes,
    requestTimeoutMs: compilerTreeTimeoutMs,
    allowRequest(method, url) {
      if (options.fixedReader) assertTrustedDirectNode("Fixed compiler source reader");
      if (method !== "GET" || url.pathname + url.search !== allowed) return false;
      options.checkSource?.(url);
      return true;
    },
  });
  return async (endpoint: string, deadline: number): Promise<GitHubMetadataResponse> => {
    const origin = "https://api.github.com";
    const url = URL.parse(endpoint, origin);
    if (
      allowed !== undefined ||
      !url ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/(?:repos\/boburning\/portcove\/(?:git\/(?:commits|trees)|contents|compare)|repositories\/1354613114\/compare)\//u.test(
        url.pathname,
      )
    )
      throw new Error("compiler source reader escaped its admitted route");
    allowed = url.pathname + url.search;
    const policy: GitHubRequestPolicy = { replay: "once", attempts: 0, deadline };
    try {
      const response = await client.request(`GET ${allowed}`, { request: { portcove: policy } });
      if (response.status !== 200)
        throw new Error(
          `compiler source provider returned unexpected HTTP status ${response.status}`,
        );
      const link = response.headers.link;
      return {
        status: response.status,
        body: response.data as unknown,
        headers: typeof link === "string" ? new Map([["link", link]]) : new Map(),
      };
    } finally {
      try {
        await policy.admissionSettled;
        options.checkSource?.(url);
      } finally {
        allowed = undefined;
      }
    }
  };
}

/** Authenticated source equality is one necessary compiler condition. This
 * does not authenticate execution, outputs, compatibility or native behavior.
 * The fixed controller chooses this inventory; candidate files are never run. */
export async function compareReleaseCompilerSource(
  trustedRoot: string,
  candidateTree: string,
  options: { readTree?: CompilerTreeReader } = {},
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
  const result = await compareCompilerClosure(closure, candidateTree, options);
  if (git(["rev-parse", "HEAD"]).trim() !== controllerCommit)
    throw new Error("fixed controller changed during compiler source comparison");
  return result;
}

export async function compareCompilerClosure(
  closure: CompilerSourceClosure,
  candidateTree: string,
  options: { readTree?: CompilerTreeReader },
) {
  if (!/^[a-f0-9]{40}$/u.test(candidateTree))
    throw new Error("compiler candidate tree unavailable");
  const controllerCommit = closure.source_commit;
  const local = new Map(closure.paths.map((entry) => [entry.path, entry.entry]));
  let fetchTree = options.readTree;
  if (!fetchTree) {
    const deadline = Math.min(
      coordinatorCommandDeadline() ?? Infinity,
      performance.now() + compilerTreeRequestLimit * compilerTreeTimeoutMs,
    );
    const read = await createCompilerSourceReader({
      credential: localDeveloperCredential({ deadline }),
      deadline,
      maxBytes: 2 * 1024 * 1024,
    });
    fetchTree = async (sha) =>
      (await read(`repos/boburning/portcove/git/trees/${sha}`, deadline)).body;
  }
  const provider = fetchTree;
  const trees = new Map<string, Map<string, { mode: string; type: string; sha: string }>>();
  let requests = 0;
  const readTree = async (sha: string) => {
    const cached = trees.get(sha);
    if (cached) return cached;
    if (++requests > compilerTreeRequestLimit)
      throw new Error("compiler source tree request bound exhausted");
    const body = await provider(sha);
    if (
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
        raw.path === "." ||
        raw.path === ".." ||
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
    const rows = [...entries.entries()].sort(([a, left], [b, right]) =>
      Buffer.compare(
        Buffer.from(a + (left.type === "tree" ? "/" : "")),
        Buffer.from(b + (right.type === "tree" ? "/" : "")),
      ),
    );
    for (const [, entry] of rows)
      if (
        !(
          (entry.type === "tree" && entry.mode === "040000") ||
          (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) ||
          (entry.type === "commit" && entry.mode === "160000")
        )
      )
        throw new Error("unsupported compiler Git tree entry kind");
    inspectRemoteGitObject(
      "tree",
      sha,
      Buffer.concat(
        rows.map(([name, entry]) =>
          Buffer.concat([
            Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${name}\0`),
            Buffer.from(entry.sha, "hex"),
          ]),
        ),
      ),
    );
    trees.set(sha, entries);
    return entries;
  };
  const observed = [];
  for (const filename of compilerProducerPaths) {
    let tree = candidateTree;
    let found: { mode: string; type: string; sha: string } | undefined;
    const parts = filename.split("/");
    for (const [index, part] of parts.entries()) {
      found = (await readTree(tree)).get(part);
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
    observed.push({ path: filename, ...(found ?? { absent: true }) });
  }
  return Object.freeze({
    evidence_scope: options.readTree ? "injected-provider" : "github.com",
    authority: "none",
    controller_commit: controllerCommit,
    candidate_tree: candidateTree,
    closure_sha256: createHash("sha256").update(JSON.stringify(observed)).digest("hex"),
    paths: Object.freeze(observed),
    scope: "exact producing workflow and conservative maintained helper/configuration closure only",
  });
}

export interface PreparedCompilerSource {
  source_commit: string;
  source_tree: string;
  prepared_commit: string;
  prepared_tree: string;
  version: string;
}
/** Reuse the actual four-file preparation transform. Complete authenticated net
 * trees, one exact parent and expected blob hashes prohibit a blanket version
 * exception from hiding dependency, script, configuration or arbitrary edits. */
export async function inspectPreparedCompilerSourceAsync(
  read: (endpoint: string, deadline: number) => Promise<GitHubMetadataResponse>,
  candidate: PreparedCompilerSource,
  deadline: number,
) {
  const collection = preparedCompilerSourceRequests(candidate, deadline);
  let step = collection.next();
  while (!step.done) step = collection.next(await read(step.value.endpoint, step.value.deadline));
  return step.value;
}

export function* preparedCompilerSourceRequests(
  rawCandidate: PreparedCompilerSource,
  deadline = Infinity,
) {
  const candidate = structuredClone(rawCandidate);
  for (const oid of [
    candidate.source_commit,
    candidate.source_tree,
    candidate.prepared_commit,
    candidate.prepared_tree,
  ])
    if (!/^[a-f0-9]{40}$/u.test(oid))
      throw new Error("exact compiler preparation source identities unavailable");
  const delta = yield* releaseSourceChangeRequests(
    {
      base_commit: candidate.source_commit,
      source_commit: candidate.prepared_commit,
      source_tree: candidate.prepared_tree,
    },
    { deadline },
  );
  if (
    delta.base_tree !== candidate.source_tree ||
    delta.commits.length !== 1 ||
    delta.commits[0]!.oid !== candidate.prepared_commit ||
    !isDeepStrictEqual(delta.commits[0]!.parents, [candidate.source_commit])
  )
    throw new Error(
      "compiler prepared source is not the exact single-parent reservation transform",
    );
  const changes = delta.changes.filter(
    (entry) => !(entry.before?.type === "tree" && entry.after?.type === "tree"),
  );
  const names = [
    "Cargo.toml",
    "Cargo.lock",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
  ].sort();
  if (
    !isDeepStrictEqual(changes.map((entry) => entry.path).sort(), names) ||
    changes.some(
      (entry) =>
        entry.before?.type !== "blob" ||
        entry.after?.type !== "blob" ||
        entry.before.mode !== "100644" ||
        entry.after.mode !== "100644",
    )
  )
    throw new Error("prepared source changes more than exact existing version authorities");
  let requests = 0;
  const blobs = new Map<string, string>();
  const read = function* (
    filename: string,
  ): Generator<ReleaseSourceRead, string, GitHubMetadataResponse> {
    const cached = blobs.get(filename);
    if (cached !== undefined) return cached;
    if (
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(filename) ||
      filename.split("/").some((part) => part === "." || part === "..") ||
      ++requests > 32
    )
      throw new Error("prepared compiler source reader escaped its bound");
    if (performance.now() >= deadline)
      throw new Error("prepared compiler source deadline exhausted");
    const response = yield {
      endpoint: `repos/boburning/portcove/contents/${filename}?ref=${candidate.source_commit}`,
      deadline,
    };
    if (performance.now() >= deadline)
      throw new Error("prepared compiler source deadline exhausted");
    const body = response.body;
    if (
      response.status !== 200 ||
      !isRecord(body) ||
      body.type !== "file" ||
      body.path !== filename ||
      body.encoding !== "base64" ||
      typeof body.content !== "string" ||
      body.content.length > 2 * 1024 * 1024 ||
      typeof body.size !== "number" ||
      !Number.isSafeInteger(body.size) ||
      body.size < 1 ||
      body.size > 1024 * 1024 ||
      typeof body.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(body.sha)
    )
      throw new Error("prepared compiler original source blob unavailable");
    const bytes = Buffer.from(body.content, "base64");
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (
      bytes.length !== body.size ||
      oid !== body.sha ||
      !Buffer.from(bytes.toString("utf8")).equals(bytes) ||
      (changes.some((entry) => entry.path === filename) &&
        changes.find((entry) => entry.path === filename)!.before!.oid !== oid)
    )
      throw new Error("prepared compiler original blob bytes differ");
    blobs.set(filename, bytes.toString("utf8"));
    return bytes.toString("utf8");
  };
  const cargo = yield* read("Cargo.toml");
  const baseVersion = parseWorkspacePackage(cargo).version;
  if (typeof baseVersion !== "string") throw new Error("original source base version unavailable");
  const [, lock, packageJson, tauri, ...members] = preparationSourcePaths(cargo);
  for (const filename of [...members, lock!, packageJson!, tauri!]) yield* read(filename);
  const expected = reproducePreparedReleaseVersionFiles(
    (filename) => {
      const content = blobs.get(filename);
      if (content === undefined)
        throw new Error("prepared compiler source input was not collected");
      return content;
    },
    {
      base_version: baseVersion,
      version: candidate.version,
    },
  );
  for (const [filename, content] of expected) {
    const bytes = Buffer.from(content);
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (changes.find((entry) => entry.path === filename)?.after?.oid !== oid)
      throw new Error(`compiler prepared version bytes differ: ${filename}`);
  }
  return {
    authority: "none",
    ...candidate,
    prepared_change_set_sha256: delta.change_set_sha256,
    source_blob_reads: requests,
  };
}
