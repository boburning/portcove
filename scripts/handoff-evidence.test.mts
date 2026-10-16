import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileIdentity } from "./development-evidence.mts";
import {
  checkHandoff,
  inspectResource,
  readSelectedPullRequest,
  renderHandoff,
  validateHandoff,
  HANDOFF_LIMITS,
} from "./handoff-evidence.mts";

const revision = "a".repeat(40);
const captured_at = "2026-10-13T18:00:00Z";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "handoff 雪-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = path.join(root, "evidence.json");
  await writeFile(location, "owned snapshot");
  const resource = {
    id: "library",
    role: "library",
    required: true,
    kind: "file",
    snapshot_at: captured_at,
    ...(await fileIdentity(location)),
  };
  return {
    root,
    record: {
      format_version: 1,
      revision,
      captured_at,
      library: { id: "explicit-library", resource_id: "library" },
      resources: [resource],
      completed: [{ name: "return", method: "operator", evidence_ids: ["library"] }],
      outstanding: ["broader acceptance"],
      resume_condition: "Recheck actual writer and acceptance.",
    },
  };
}

test("actual CLI verifies owned bytes without modifying manifest or resource", async (t) => {
  const { root, record } = await fixture(t);
  const manifest = path.join(root, "handoff.json");
  const bytes = JSON.stringify(record);
  await writeFile(manifest, bytes);
  const result = spawnSync(
    process.execPath,
    ["scripts/handoff-evidence.mts", "check", "--manifest", manifest, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "verified");
  assert.equal(report.completed[0].method, "operator");
  assert.match(report.authority, /no admission/);
  assert.equal(await readFile(manifest, "utf8"), bytes);
  assert.equal(await readFile(record.resources[0].path, "utf8"), "owned snapshot");
});

test("missing, changed and unavailable resources block only verifiable evidence reuse", async (t) => {
  const { record } = await fixture(t);
  await writeFile(record.resources[0].path, "changed");
  assert.equal((await checkHandoff(record)).resources[0].status, "changed");
  await rm(record.resources[0].path);
  const missing = await checkHandoff(record);
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.resources[0].status, "missing");
  assert.equal(missing.completed[0].reusable, false);
  await writeFile(record.resources[0].path, "owned snapshot");
  assert.equal(
    await inspectResource(record.resources[0], {
      fileIdentity: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
    "unavailable",
  );
});

test("directory snapshots are explicitly scoped and mutable snapshots stay distinct", async (t) => {
  const { root, record } = await fixture(t);
  const directory = path.join(root, "runtime");
  await mkdir(directory);
  await writeFile(path.join(directory, "save.bin"), "before");
  const before = await fileIdentity(path.join(directory, "save.bin"));
  const resource = {
    ...record.resources[0],
    kind: "directory",
    path: directory,
    scope: "selected-files",
    files: [{ relative_path: "save.bin", bytes: before.bytes, sha256: before.sha256 }],
  };
  record.resources = [resource];
  assert.equal((await checkHandoff(record)).status, "verified");
  await writeFile(path.join(directory, "save.bin"), "game writes");
  assert.equal((await checkHandoff(record)).status, "incomplete");
  const after = await fileIdentity(path.join(directory, "save.bin"));
  const current = structuredClone(record);
  current.resources[0].snapshot_at = "2026-10-13T18:01:00Z";
  current.resources[0].files = [
    { relative_path: "save.bin", bytes: after.bytes, sha256: after.sha256 },
  ];
  assert.equal((await checkHandoff(current)).status, "verified");
  assert.equal((await checkHandoff(record)).status, "incomplete");
  for (const relative_path of [
    "../outside",
    "/outside",
    "C:/outside",
    "nested\\outside",
    "a/../outside",
  ]) {
    const invalid = structuredClone(record);
    invalid.resources[0].files[0].relative_path = relative_path;
    assert.throws(() => validateHandoff(invalid), /unsafe/);
  }
});

test("legacy, invalid references and changed expected source fail closed", async (t) => {
  const { record } = await fixture(t);
  assert.throws(() => validateHandoff({ ...record, format_version: 0 }), /recapture/);
  assert.throws(
    () => validateHandoff({ ...record, library: { id: "x", resource_id: "missing" } }),
    /reference/,
  );
  const report = await checkHandoff(record, { expectedRevision: "b".repeat(40) });
  assert.equal(report.status, "incomplete");
  assert.equal(report.completed[0].reusable, false);
  record.pull_request = { repository: "boburning/portcove", number: 1388, head: revision };
  for (const status of ["unknown", "changed"]) {
    const stale = await checkHandoff(record, { remote: () => ({ status }) });
    assert.equal(stale.status, "incomplete");
    assert.equal(stale.completed[0].reusable, false);
  }
});

test("selected remote readback supersedes draft history and rejects changed/incomplete identities", () => {
  const selected = { repository: "boburning/portcove", number: 1388, head: revision };
  const pr = {
    number: 1388,
    base: { repo: { full_name: selected.repository } },
    head: { sha: revision },
    state: "closed",
    merged: true,
    merge_commit_sha: "b".repeat(40),
    merged_at: captured_at,
  };
  const run = (value) => (_command, _args, options) => {
    assert.equal(options.timeout, 15000);
    return { status: 0, stdout: JSON.stringify(value) };
  };
  assert.equal(readSelectedPullRequest(selected, run(pr)).state, "merged");
  assert.equal(
    readSelectedPullRequest(selected, run({ ...pr, head: { sha: "c".repeat(40) } })).status,
    "changed",
  );
  assert.equal(
    readSelectedPullRequest(selected, run({ ...pr, merged_at: null })).status,
    "unknown",
  );
  assert.equal(readSelectedPullRequest(selected, () => ({ status: 1 })).status, "unknown");
});

test("Unicode summaries remain byte bounded while preserving a failed verdict and totals", async (t) => {
  const { record } = await fixture(t);
  record.outstanding = ["雪".repeat(20000)];
  const report = await checkHandoff(record, { inspect: async () => "unavailable" });
  const rendered = renderHandoff(report, "/local/handoff.json");
  assert.ok(Buffer.byteLength(rendered, "utf8") <= HANDOFF_LIMITS.outputBytes);
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.status, "incomplete");
  assert.equal(parsed.resource_counts.unavailable, 1);
  assert.equal(parsed.details_omitted, true);
});
