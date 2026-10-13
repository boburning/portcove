import { lstat, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity } from "./development-evidence.mjs";

const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
export const HANDOFF_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  resources: 128,
  files: 10000,
  snapshotBytes: 1024 * 1024 * 1024,
  outputBytes: 16384,
});
const roles = new Set([
  "package",
  "profile",
  "library",
  "runtime",
  "original",
  "evidence",
  "inventory",
  "native-custody",
]);
function requireValue(condition, message) {
  if (!condition) throw new Error(`Handoff rejected: ${message}`);
}
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
function snapshotFile(value) {
  requireValue(
    value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && digest.test(value.sha256),
    "invalid file identity",
  );
}

export function validateHandoff(record) {
  requireValue(
    record?.format_version === 1,
    "legacy/unknown format; explicitly recapture, never infer custody",
  );
  requireValue(
    sha.test(record.revision) && Number.isFinite(Date.parse(record.captured_at)),
    "source and capture time required",
  );
  requireValue(
    record.library && typeof record.library.id === "string" && record.library.id.length > 0,
    "explicit library identity required",
  );
  requireValue(
    Array.isArray(record.resources) &&
      record.resources.length > 0 &&
      record.resources.length <= HANDOFF_LIMITS.resources,
    "invalid resource inventory",
  );
  const ids = new Set();
  let files = 0;
  let bytes = 0;
  for (const resource of record.resources) {
    requireValue(
      resource &&
        typeof resource.id === "string" &&
        resource.id.length > 0 &&
        !ids.has(resource.id),
      "duplicate/empty resource ID",
    );
    ids.add(resource.id);
    requireValue(
      roles.has(resource.role) &&
        typeof resource.required === "boolean" &&
        path.isAbsolute(resource.path),
      "resource role, absolute location and required flag needed",
    );
    requireValue(
      Number.isFinite(Date.parse(resource.snapshot_at)),
      "snapshot time required, including mutable resources",
    );
    if (resource.kind === "file") {
      snapshotFile(resource);
      files++;
      bytes += resource.bytes;
    } else {
      requireValue(
        resource.kind === "directory" &&
          resource.scope === "selected-files" &&
          Array.isArray(resource.files) &&
          resource.files.length > 0,
        "directory requires explicit selected-file snapshot",
      );
      const names = new Set();
      for (const file of resource.files) {
        requireValue(
          typeof file.relative_path === "string" &&
            file.relative_path.length > 0 &&
            !/^[\\/]|^[A-Za-z]:|\\|\0/u.test(file.relative_path) &&
            !file.relative_path.split("/").some((part) => ["", ".", ".."].includes(part)),
          "unsafe inventory path",
        );
        const name =
          process.platform === "win32" ? file.relative_path.toLowerCase() : file.relative_path;
        requireValue(!names.has(name), "duplicate inventory path");
        names.add(name);
        snapshotFile(file);
        files++;
        bytes += file.bytes;
      }
    }
  }
  requireValue(
    files <= HANDOFF_LIMITS.files && bytes <= HANDOFF_LIMITS.snapshotBytes,
    "snapshot exceeds bounded inspection limits",
  );
  requireValue(ids.has(record.library.resource_id), "library resource reference missing");
  requireValue(
    Array.isArray(record.completed) &&
      strings(record.outstanding) &&
      typeof record.resume_condition === "string",
    "observation and resume fields required",
  );
  for (const observation of record.completed) {
    requireValue(
      typeof observation.name === "string" &&
        observation.name.length > 0 &&
        ["automated", "operator"].includes(observation.method) &&
        strings(observation.evidence_ids) &&
        observation.evidence_ids.length > 0 &&
        observation.evidence_ids.every((id) => ids.has(id)),
      "completed observation requires explicit method and known evidence",
    );
  }
  if (record.pull_request) {
    const pr = record.pull_request;
    requireValue(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pr.repository) &&
        Number.isSafeInteger(pr.number) &&
        pr.number > 0 &&
        sha.test(pr.head),
      "invalid selected PR identity",
    );
    requireValue(pr.head === record.revision, "selected PR head differs from source");
  }
  return record;
}

async function inspectFile(file, identity = fileIdentity) {
  const stats = await lstat(file.path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.bytes) return "changed";
  const actual = await identity(file.path);
  return actual.sha256 === file.sha256 && actual.bytes === file.bytes ? "verified" : "changed";
}

export async function inspectResource(resource, dependencies = {}) {
  try {
    if (resource.kind === "file") return await inspectFile(resource, dependencies.fileIdentity);
    const stats = await lstat(resource.path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return "changed";
    const root = await realpath(resource.path);
    for (const file of resource.files) {
      const target = path.join(root, ...file.relative_path.split("/"));
      const resolved = await realpath(target);
      const relative = path.relative(root, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return "changed";
      const status = await inspectFile({ ...file, path: target }, dependencies.fileIdentity);
      if (status !== "verified") return status;
    }
    return "verified";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unavailable";
  }
}

export function readSelectedPullRequest(selected, run = spawnSync) {
  const result = run("gh", ["api", `repos/${selected.repository}/pulls/${selected.number}`], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    return { status: "unknown", reason: "remote readback unavailable" };
  try {
    const pr = JSON.parse(result.stdout);
    if (
      pr.number !== selected.number ||
      pr.base?.repo?.full_name?.toLowerCase() !== selected.repository.toLowerCase() ||
      !sha.test(pr.head?.sha)
    )
      throw new Error("identity");
    if (pr.head.sha !== selected.head) return { status: "changed", head: pr.head.sha };
    if (
      pr.merged === true &&
      sha.test(pr.merge_commit_sha) &&
      Number.isFinite(Date.parse(pr.merged_at))
    )
      return {
        status: "verified",
        state: "merged",
        head: pr.head.sha,
        merge_commit: pr.merge_commit_sha,
        observed_at: new Date().toISOString(),
      };
    if (
      pr.merged === false &&
      ["open", "closed"].includes(pr.state) &&
      typeof pr.draft === "boolean"
    )
      return {
        status: "verified",
        state: pr.state === "open" && pr.draft ? "draft" : pr.state,
        head: pr.head.sha,
        observed_at: new Date().toISOString(),
      };
  } catch {
    /* Incomplete coverage never supplies a current state. */
  }
  return { status: "unknown", reason: "remote identity/state incomplete" };
}

export async function checkHandoff(
  record,
  { expectedRevision, inspect = inspectResource, remote = readSelectedPullRequest } = {},
) {
  validateHandoff(record);
  const sourceMatches =
    expectedRevision === undefined ||
    (sha.test(expectedRevision) && record.revision === expectedRevision);
  const resources = [];
  for (const resource of record.resources)
    resources.push({
      id: resource.id,
      role: resource.role,
      required: resource.required,
      status: await inspect(resource),
    });
  const verified = new Set(
    resources.filter((resource) => resource.status === "verified").map((resource) => resource.id),
  );
  const selected = record.pull_request
    ? await remote(record.pull_request)
    : { status: "not-requested" };
  const dependenciesMatch =
    sourceMatches &&
    resources.every((resource) => !resource.required || resource.status === "verified") &&
    ["verified", "not-requested"].includes(selected.status);
  const completed = record.completed.map((observation) => ({
    ...observation,
    reusable: dependenciesMatch && observation.evidence_ids.every((id) => verified.has(id)),
  }));
  const reusable = dependenciesMatch && completed.every((observation) => observation.reusable);
  return {
    format_version: 1,
    status: reusable ? "verified" : "incomplete",
    source_matches: sourceMatches,
    revision: record.revision,
    resources,
    completed,
    outstanding: record.outstanding,
    resume_condition: record.resume_condition,
    pull_request: selected,
    authority:
      "Resource and observation references only; no admission, execution, acceptance or merge authority.",
  };
}

export function renderHandoff(report, reference) {
  // The compact view preserves the verdict and totals even when details exceed the byte budget.
  const summary = {
    ...report,
    manifest: reference,
    resource_counts: {},
    observation_counts: {
      total: report.completed.length,
      reusable: report.completed.filter((item) => item.reusable).length,
    },
  };
  for (const resource of report.resources)
    summary.resource_counts[resource.status] = (summary.resource_counts[resource.status] ?? 0) + 1;
  let output = JSON.stringify(summary);
  if (Buffer.byteLength(`${output}\n`, "utf8") > HANDOFF_LIMITS.outputBytes) {
    summary.resources = [];
    summary.completed = [];
    summary.outstanding = [];
    summary.resume_condition = "See manifest for the full resume condition.";
    summary.details_omitted = true;
    output = JSON.stringify(summary);
  }
  requireValue(
    Buffer.byteLength(`${output}\n`, "utf8") <= HANDOFF_LIMITS.outputBytes,
    "summary exceeds byte limit",
  );
  return `${output}\n`;
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "usage: handoff-evidence.mjs check --manifest FILE [--expected-revision SHA] [--json]\nRead-only reference verification; no execution or acceptance authority.\n",
    );
    return;
  }
  requireValue(
    args[0] === "check",
    "usage: handoff-evidence.mjs check --manifest FILE [--expected-revision SHA] [--json]",
  );
  let manifest;
  let expectedRevision;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--manifest" && !manifest) manifest = args[++index];
    else if (args[index] === "--expected-revision" && !expectedRevision)
      expectedRevision = args[++index];
    else if (args[index] === "--json" && !json) json = true;
    else throw new Error("Unknown/duplicate handoff argument");
  }
  requireValue(
    typeof manifest === "string" &&
      manifest.length > 0 &&
      (expectedRevision === undefined || sha.test(expectedRevision)),
    "manifest and valid expected revision needed",
  );
  const reference = path.resolve(manifest);
  const stats = await lstat(reference);
  requireValue(
    stats.isFile() && !stats.isSymbolicLink() && stats.size <= HANDOFF_LIMITS.manifestBytes,
    "manifest must be a bounded ordinary file",
  );
  const record = JSON.parse(await readFile(reference, "utf8"));
  const report = await checkHandoff(record, { expectedRevision });
  process.stdout.write(
    json
      ? renderHandoff(report, reference)
      : `Handoff ${report.status}; selected PR ${report.pull_request.state ?? report.pull_request.status}; raw references: ${reference}\n`,
  );
  process.exitCode = report.status === "verified" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (process.argv.includes("--json"))
      process.stdout.write(
        '{"status":"incomplete","reason":"manifest or verification unavailable; inspect stderr"}\n',
      );
    process.exitCode = 1;
  }
}
