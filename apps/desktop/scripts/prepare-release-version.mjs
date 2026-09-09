import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspacePackage } from "../../../scripts/check-release-metadata.mjs";
import { proposeApplicationVersion } from "./release-version-policy.mjs";

function repositoryGit(repository, environment = {}) {
  // Candidate contents are read as blobs. No checkout, hooks, filters, build
  // scripts, real index or caller-controlled Git environment is executed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  // Link-based object creation preserves existing content when simultaneous
  // preparations write identical objects (including on Windows).
  return (args, input) => execFileSync("git", ["-C", repository, "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.fsmonitor=false", "-c", "core.createObject=link", "-c", "commit.gpgSign=false", "-c", "i18n.commitEncoding=UTF-8", ...args], {
    encoding: "utf8", input, env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", ...environment },
    windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
}

function sourceFile(git, commit, filename) {
  const entry = git(["ls-tree", commit, "--", filename]).trim();
  if (!entry.startsWith("100644 blob ") || !entry.endsWith(`\t${filename}`)) throw new Error(`version authority must be a regular source blob: ${filename}`);
  return git(["show", `${commit}:${filename}`]);
}

function replaceOnce(text, pattern, replacement, label) {
  let count = 0;
  const updated = text.replace(pattern, (...args) => { count += 1; return replacement(...args); });
  if (count !== 1) throw new Error(`expected one ${label}, found ${count}`);
  return updated;
}

function workspacePackages(git, commit, cargo) {
  // Support the repository's explicit member list, rejecting globs, traversal
  // and other TOML forms instead of guessing the version authority.
  const list = cargo.match(/^members\s*=\s*(\[[\s\S]*?\])/m)?.[1];
  const members = JSON.parse(list?.replace(/,\s*]/, "]") ?? "null");
  if (!Array.isArray(members) || !members.length) throw new Error("explicit workspace members are required");
  const names = members.map(member => {
    if (typeof member !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(member)) throw new Error("unsupported workspace member path");
    const manifest = sourceFile(git, commit, `${member}/Cargo.toml`);
    const table = manifest.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
    const name = table?.match(/^name\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m)?.[1];
    if (!name || !/^version\.workspace\s*=\s*true\s*$/m.test(table)) throw new Error(`workspace version inheritance is required: ${member}`);
    return name;
  });
  if (new Set(names).size !== names.length) throw new Error("duplicate workspace package identity");
  return names;
}

function updatedLock(lock, names, base, version) {
  const found = new Set();
  const updated = lock.replace(/^\[\[package\]\]\r?\n[\s\S]*?(?=^\[\[package\]\]|(?![\s\S]))/gm, block => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    if (!names.includes(name)) return block;
    if (found.has(name) || /^source\s*=/m.test(block)) throw new Error(`ambiguous workspace lock identity: ${name}`);
    found.add(name);
    return replaceOnce(block, /^version = "([^"]+)"$/gm, (_line, current) => {
      if (current !== base) throw new Error(`workspace lock version drift: ${name}`);
      return `version = "${version}"`;
    }, `${name} lock version`);
  });
  if (found.size !== names.length) throw new Error("workspace package missing from Cargo.lock");
  return updated;
}

function versionedFiles(git, proposal) {
  const { source_commit: source, base_version: base, version } = proposal;
  const cargo = sourceFile(git, source, "Cargo.toml");
  if (parseWorkspacePackage(cargo).version !== base) throw new Error("frozen workspace version differs from reviewed base");
  const names = workspacePackages(git, source, cargo);
  const files = new Map();
  files.set("Cargo.toml", replaceOnce(cargo, /(^\[workspace\.package\]\r?\n[\s\S]*?^version\s*=\s*)"[^"]+"/gm, (_line, prefix) => `${prefix}"${version}"`, "workspace version"));
  files.set("Cargo.lock", updatedLock(sourceFile(git, source, "Cargo.lock"), names, base, version));
  for (const filename of ["apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"]) {
    const original = sourceFile(git, source, filename);
    if (JSON.parse(original).version !== base) throw new Error(`frozen version authority drift: ${filename}`);
    files.set(filename, replaceOnce(original, /^(\s*"version"\s*:\s*)"[^"]+"/gm, (_line, prefix) => `${prefix}"${version}"`, filename));
  }
  return files;
}

function allocationRefs(proposal) {
  return [`refs/portcove/prepared-versions/v${proposal.version}`, `refs/portcove/prepared-commits/${proposal.source_commit}`];
}

function allocationTransaction(git, refs, preparedCommit, operation) {
  // Readers of multiple loose refs can observe part of a committed transaction.
  // Verify under the same locks used for creation, with bounded lock contention.
  git(["-c", "core.filesRefLockTimeout=1000", "update-ref", "--no-deref", "--stdin"],
    `start\n${refs.map(ref => `${operation} ${ref} ${preparedCommit}`).join("\n")}\nprepare\ncommit\n`);
}

async function preparedTree(repository, proposal) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "portcove-version-index-"));
  try {
    const git = repositoryGit(repository, { GIT_INDEX_FILE: path.join(temporary, "index") });
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
export async function prepareReleaseVersion(repository, classification, publishedVersions) {
  const proposal = proposeApplicationVersion(classification, publishedVersions);
  const git = repositoryGit(path.resolve(repository));
  if (git(["rev-parse", "--verify", `${proposal.source_commit}^{commit}`]).trim() !== proposal.source_commit) throw new Error("frozen commit does not resolve exactly");
  const tree = await preparedTree(repository, proposal);
  const intent = JSON.stringify({ proposal, compatibility: classification.compatibility, migration_notes: classification.migration_notes ?? "" });
  const intentHash = createHash("sha256").update(intent).digest("hex");
  const date = git(["show", "-s", "--format=%cI", proposal.source_commit]).trim();
  const commitGit = repositoryGit(repository, {
    GIT_AUTHOR_NAME: "Portcove version preparation", GIT_AUTHOR_EMAIL: "version-preparation@portcove.invalid", GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Portcove version preparation", GIT_COMMITTER_EMAIL: "version-preparation@portcove.invalid", GIT_COMMITTER_DATE: date,
  });
  const preparedCommit = commitGit(["commit-tree", tree, "-p", proposal.source_commit], `Prepare application ${proposal.version}\n\nPortcove-Preparation-SHA256: ${intentHash}\n${intent}\n`).trim();
  const refs = allocationRefs(proposal);
  try {
    allocationTransaction(git, refs, preparedCommit, "create");
  } catch (creationError) {
    try {
      // A concurrent identical request can create both receipts first. Verify
      // both together; never fill in a partial receipt or overwrite a conflict.
      allocationTransaction(git, refs, preparedCommit, "verify");
    } catch (error) {
      throw new Error("version or source commit already allocated differently, incomplete, or locked", {
        cause: new AggregateError([creationError, error], "receipt creation and verification failed"),
      });
    }
  }
  return { ...proposal, prepared_commit: preparedCommit, prepared_tree: tree, intent_sha256: intentHash, allocation_refs: refs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, inputPath] = process.argv.slice(2);
  if (process.argv.length !== 4) throw new Error("usage: prepare-release-version.mjs REPOSITORY INPUT.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  console.log(JSON.stringify(await prepareReleaseVersion(repository, input.classification, input.published_versions)));
}
