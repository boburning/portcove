import { isRecord } from "../../../scripts/runtime-values.mts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseWorkspacePackage } from "../../../scripts/check-release-metadata.mts";
import {
  proposeApplicationVersion,
  parseVersionClassification,
} from "./release-version-policy.mts";

function repositoryGit(repository: string, environment: NodeJS.ProcessEnv = {}) {
  // Candidate contents are read as blobs. No checkout, hooks, filters, build
  // scripts, real index or caller-controlled Git environment is executed.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  // Link-based object creation preserves existing content when simultaneous
  // preparations write identical objects (including on Windows).
  return (args: readonly string[], input?: string) =>
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.createObject=link",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "i18n.commitEncoding=UTF-8",
        ...args,
      ],
      {
        encoding: "utf8",
        input,
        env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", ...environment },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
}

type Git = ReturnType<typeof repositoryGit>;
type Proposal = ReturnType<typeof proposeApplicationVersion>;
function sourceFile(git: Git, commit: string, filename: string) {
  const entry = git(["ls-tree", commit, "--", filename]).trim();
  if (!entry.startsWith("100644 blob ") || !entry.endsWith(`\t${filename}`))
    throw new Error(`version authority must be a regular source blob: ${filename}`);
  return git(["show", `${commit}:${filename}`]);
}

function replaceOnce(
  text: string,
  pattern: RegExp,
  replacement: (line: string, capture: string) => string,
  label: string,
) {
  let count = 0;
  const updated = text.replace(pattern, (line: string, capture: unknown) => {
    count += 1;
    if (typeof capture !== "string") throw new Error(`missing ${label} capture`);
    return replacement(line, capture);
  });
  if (count !== 1) throw new Error(`expected one ${label}, found ${count}`);
  return updated;
}

function workspacePackages(git: Git, commit: string, cargo: string) {
  // Support the repository's explicit member list, rejecting globs, traversal
  // and other TOML forms instead of guessing the version authority.
  const list = cargo.match(/^members\s*=\s*(\[[\s\S]*?\])/m)?.[1];
  const members: unknown = JSON.parse(list?.replace(/,\s*]/, "]") ?? "null");
  if (!Array.isArray(members) || !members.length)
    throw new Error("explicit workspace members are required");
  const values: unknown[] = members;
  const names = values.map((member) => {
    if (typeof member !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(member))
      throw new Error("unsupported workspace member path");
    const manifest = sourceFile(git, commit, `${member}/Cargo.toml`);
    const table = manifest.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
    const name = table?.match(/^name\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m)?.[1];
    if (!name || !/^version\.workspace\s*=\s*true\s*$/m.test(table ?? ""))
      throw new Error(`workspace version inheritance is required: ${member}`);
    return name;
  });
  if (new Set(names).size !== names.length) throw new Error("duplicate workspace package identity");
  return names;
}

function updatedLock(lock: string, names: readonly string[], base: string, version: string) {
  const found = new Set<string>();
  const updated = lock.replace(
    /^\[\[package\]\]\r?\n[\s\S]*?(?=^\[\[package\]\]|(?![\s\S]))/gm,
    (block: string) => {
      const name = block.match(/^name = "([^"]+)"$/m)?.[1];
      if (name === undefined || !names.includes(name)) return block;
      if (found.has(name) || /^source\s*=/m.test(block))
        throw new Error(`ambiguous workspace lock identity: ${name}`);
      found.add(name);
      return replaceOnce(
        block,
        /^version = "([^"]+)"$/gm,
        (_line, current) => {
          if (current !== base) throw new Error(`workspace lock version drift: ${name}`);
          return `version = "${version}"`;
        },
        `${name} lock version`,
      );
    },
  );
  if (found.size !== names.length) throw new Error("workspace package missing from Cargo.lock");
  return updated;
}

function versionedFiles(
  git: Git,
  proposal: Pick<Proposal, "source_commit" | "base_version" | "version">,
) {
  const { source_commit: source, base_version: base, version } = proposal;
  const cargo = sourceFile(git, source, "Cargo.toml");
  if (parseWorkspacePackage(cargo).version !== base)
    throw new Error("frozen workspace version differs from reviewed base");
  const names = workspacePackages(git, source, cargo);
  const files = new Map<string, string>();
  files.set(
    "Cargo.toml",
    replaceOnce(
      cargo,
      /(^\[workspace\.package\]\r?\n[\s\S]*?^version\s*=\s*)"[^"]+"/gm,
      (_line, prefix) => `${prefix}"${version}"`,
      "workspace version",
    ),
  );
  files.set("Cargo.lock", updatedLock(sourceFile(git, source, "Cargo.lock"), names, base, version));
  for (const filename of ["apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"]) {
    const original = sourceFile(git, source, filename);
    const metadata: unknown = JSON.parse(original);
    if (!isRecord(metadata) || metadata.version !== base)
      throw new Error(`frozen version authority drift: ${filename}`);
    files.set(
      filename,
      replaceOnce(
        original,
        /^(\s*"version"\s*:\s*)"[^"]+"/gm,
        (_line, prefix) => `${prefix}"${version}"`,
        filename,
      ),
    );
  }
  return files;
}

/** Export an already allocated preparation. No checkout, ref write, reallocation
 * or network access occurs. The caller must authenticate the reservation. */
export function exportPreparedReleaseVersion(
  repository: string,
  candidate: {
    source_commit: string;
    source_tree: string;
    prepared_commit: string;
    prepared_tree: string;
    version: string;
    intent_sha256: string;
  },
) {
  const read = repositoryGit(repository);
  const started = performance.now();
  let reads = 0;
  const git: Git = (args, input) => {
    if (++reads > 64 || performance.now() - started > 120000)
      throw new Error("prepared export Git read or duration bound exceeded");
    const result = read(args, input);
    if (performance.now() - started > 120000)
      throw new Error("prepared export Git response was late");
    return result;
  };
  if (git(["rev-parse", "--is-bare-repository"]).trim() !== "true")
    throw new Error("prepared export requires a caller-owned bare repository");
  for (const oid of [
    candidate.source_commit,
    candidate.source_tree,
    candidate.prepared_commit,
    candidate.prepared_tree,
  ])
    if (!/^[a-f0-9]{40}$/u.test(oid))
      throw new Error("prepared export requires exact Git identities");
  if (!/^[a-f0-9]{64}$/u.test(candidate.intent_sha256))
    throw new Error("preparation intent identity invalid");
  if (
    git(["rev-parse", `${candidate.source_commit}^{tree}`]).trim() !== candidate.source_tree ||
    git(["rev-parse", `${candidate.prepared_commit}^{tree}`]).trim() !== candidate.prepared_tree
  )
    throw new Error("prepared export tree identity differs");
  const date = git(["show", "-s", "--format=%cI", candidate.source_commit]).trim();
  const offset = date.slice(-6).replace(":", "");
  if (!/^[+-][0-9]{4}$/u.test(offset) || !Number.isSafeInteger(Date.parse(date) / 1000))
    throw new Error("preparation date cannot be represented exactly");
  const actor = `Portcove version preparation <version-preparation@portcove.invalid> ${Date.parse(date) / 1000} ${offset}`;
  const raw = git(["cat-file", "commit", candidate.prepared_commit]);
  const rawBytes = Buffer.from(raw);
  if (
    rawBytes.length > 128 * 1024 ||
    createHash("sha1").update(`commit ${rawBytes.length}\0`).update(rawBytes).digest("hex") !==
      candidate.prepared_commit
  )
    throw new Error("prepared raw commit bytes differ or exceed bound");
  const prefix = `tree ${candidate.prepared_tree}\nparent ${candidate.source_commit}\nauthor ${actor}\ncommitter ${actor}\n\nPrepare application ${candidate.version}\n\nPortcove-Preparation-SHA256: ${candidate.intent_sha256}\n`;
  if (!raw.startsWith(prefix) || !raw.endsWith("\n"))
    throw new Error("prepared commit metadata or parent differs");
  const intentBytes = raw.slice(prefix.length, -1);
  if (createHash("sha256").update(intentBytes).digest("hex") !== candidate.intent_sha256)
    throw new Error("prepared intent bytes differ");
  const intent: unknown = JSON.parse(intentBytes);
  if (
    !isRecord(intent) ||
    !isRecord(intent.proposal) ||
    JSON.stringify(intent) !== intentBytes ||
    intent.proposal.source_commit !== candidate.source_commit ||
    intent.proposal.version !== candidate.version ||
    typeof intent.proposal.base_version !== "string"
  )
    throw new Error("prepared proposal differs");
  const files = versionedFiles(git, {
    source_commit: candidate.source_commit,
    version: candidate.version,
    base_version: intent.proposal.base_version,
  });
  const changed = git([
    "diff-tree",
    "--no-renames",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    candidate.source_commit,
    candidate.prepared_commit,
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify([...files.keys()].sort()))
    throw new Error("prepared tree changes more than the exact version authorities");
  let total = 0;
  const blobs = [...files].map(([filename, contents]) => {
    if (sourceFile(git, candidate.prepared_commit, filename) !== contents)
      throw new Error(`prepared version edit differs: ${filename}`);
    const bytes = Buffer.from(contents);
    total += bytes.length;
    if (bytes.length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024)
      throw new Error("prepared object byte bound exceeded");
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return { path: filename, oid, contents: bytes.toString("base64") };
  });
  const message = raw.slice(raw.indexOf("\n\n") + 2);
  return {
    ...candidate,
    blobs,
    raw_commit: raw,
    commit: {
      tree: candidate.prepared_tree,
      parents: [candidate.source_commit],
      message,
      author: {
        name: "Portcove version preparation",
        email: "version-preparation@portcove.invalid",
        date,
      },
      committer: {
        name: "Portcove version preparation",
        email: "version-preparation@portcove.invalid",
        date,
      },
    },
  };
}

function allocationRefs(proposal: Proposal): [string, string] {
  return [
    `refs/portcove/prepared-versions/v${proposal.version}`,
    `refs/portcove/prepared-commits/${proposal.source_commit}`,
  ];
}

function allocationTransaction(
  git: Git,
  refs: readonly string[],
  preparedCommit: string,
  operation: "create" | "verify",
) {
  // Readers of multiple loose refs can observe part of a committed transaction.
  // Verify under the same locks used for creation, with bounded lock contention.
  git(
    ["-c", "core.filesRefLockTimeout=1000", "update-ref", "--no-deref", "--stdin"],
    `start\n${refs.map((ref) => `${operation} ${ref} ${preparedCommit}`).join("\n")}\nprepare\ncommit\n`,
  );
}

async function preparedTree(repository: string, proposal: Proposal) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "portcove-version-index-"));
  try {
    const git = repositoryGit(repository, {
      GIT_INDEX_FILE: path.join(temporary, "index"),
    });
    const files = versionedFiles(git, proposal);
    git(["read-tree", proposal.source_commit]);
    for (const [filename, contents] of files) {
      const blob = git(["hash-object", "-w", "--stdin"], contents).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${filename}`]);
    }
    return git(["write-tree"]).trim();
  } finally {
    // Only the unique temporary index created above is owned by this operation.
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Allocate only in one coordinating repository (including its linked worktrees).
 * Custom refs preserve immutable preparation receipts, not readiness or approval.
 * A protected publisher must provision its own single coordinator and fresh
 * complete published inventory; this offline operation never pushes or tags.
 */
export async function prepareReleaseVersion(
  repository: string,
  rawClassification: unknown,
  publishedVersions: unknown,
) {
  const classification = parseVersionClassification(rawClassification);
  const proposal = proposeApplicationVersion(classification, publishedVersions);
  const git = repositoryGit(path.resolve(repository));
  if (
    git(["rev-parse", "--verify", `${proposal.source_commit}^{commit}`]).trim() !==
    proposal.source_commit
  )
    throw new Error("frozen commit does not resolve exactly");
  const tree = await preparedTree(repository, proposal);
  const intent = JSON.stringify({
    proposal,
    compatibility: classification.compatibility,
    migration_notes: classification.migration_notes ?? "",
  });
  const intentHash = createHash("sha256").update(intent).digest("hex");
  const date = git(["show", "-s", "--format=%cI", proposal.source_commit]).trim();
  const commitGit = repositoryGit(repository, {
    GIT_AUTHOR_NAME: "Portcove version preparation",
    GIT_AUTHOR_EMAIL: "version-preparation@portcove.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Portcove version preparation",
    GIT_COMMITTER_EMAIL: "version-preparation@portcove.invalid",
    GIT_COMMITTER_DATE: date,
  });
  const preparedCommit = commitGit(
    ["commit-tree", tree, "-p", proposal.source_commit],
    `Prepare application ${proposal.version}\n\nPortcove-Preparation-SHA256: ${intentHash}\n${intent}\n`,
  ).trim();
  const refs = allocationRefs(proposal);
  try {
    allocationTransaction(git, refs, preparedCommit, "create");
  } catch (creationError) {
    try {
      // A concurrent identical request can create both receipts first. Verify
      // both together; never fill in a partial receipt or overwrite a conflict.
      allocationTransaction(git, refs, preparedCommit, "verify");
    } catch (error) {
      throw new Error(
        "version or source commit already allocated differently, incomplete, or locked",
        {
          cause: new AggregateError(
            [creationError, error],
            "receipt creation and verification failed",
          ),
        },
      );
    }
  }
  return {
    ...proposal,
    prepared_commit: preparedCommit,
    prepared_tree: tree,
    intent_sha256: intentHash,
    allocation_refs: refs,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, inputPath] = process.argv.slice(2);
  if (process.argv.length !== 4 || !repository || !inputPath)
    throw new Error("usage: prepare-release-version.mts REPOSITORY INPUT.json");
  const input: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (!isRecord(input)) throw new Error("version preparation input must be an object");
  console.log(
    JSON.stringify(
      await prepareReleaseVersion(repository, input.classification, input.published_versions),
    ),
  );
}
