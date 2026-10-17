import type { HandoffRecord, HandoffResource } from "./handoff-evidence.mts";
import type { TestContext } from "node:test";
import { isRecord } from "./runtime-values.mts";
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
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "handoff 雪-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = path.join(root, "evidence.json");
  await writeFile(location, "owned snapshot");
  const resource: HandoffResource = {
    id: "library",
    role: "library",
    required: true,
    kind: "file",
    snapshot_at: captured_at,
    ...(await fileIdentity(location)),
  };
  const record: HandoffRecord = {
    format_version: 1,
    revision,
    captured_at,
    library: { id: "explicit-library", resource_id: "library" },
    resources: [resource],
    completed: [{ name: "return", method: "operator", evidence_ids: ["library"] }],
    outstanding: ["broader acceptance"],
    resume_condition: "Recheck actual writer and acceptance.",
  };
  return { root, record };
}

void test("actual CLI verifies owned bytes without modifying manifest or resource", async (t) => {
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
  const report = object(JSON.parse(result.stdout));
  assert.equal(report.status, "verified");
  assert.equal(object(first(array(report.completed))).method, "operator");
  assert.match(text(report.authority), /no admission/);
  assert.equal(await readFile(manifest, "utf8"), bytes);
  assert.equal(await readFile(first(record.resources).path, "utf8"), "owned snapshot");
});

void test("missing, changed and unavailable resources block only verifiable evidence reuse", async (t) => {
  const { record } = await fixture(t);
  await writeFile(first(record.resources).path, "changed");
  assert.equal((await checkHandoff(record)).resources[0]?.status, "changed");
  await rm(first(record.resources).path);
  const missing = await checkHandoff(record);
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.resources[0]?.status, "missing");
  assert.equal(missing.completed[0]?.reusable, false);
  await writeFile(first(record.resources).path, "owned snapshot");
  assert.equal(
    await inspectResource(first(record.resources), {
      fileIdentity: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
    "unavailable",
  );
});

void test("directory snapshots are explicitly scoped and mutable snapshots stay distinct", async (t) => {
  const { root, record } = await fixture(t);
  const directory = path.join(root, "runtime");
  await mkdir(directory);
  await writeFile(path.join(directory, "save.bin"), "before");
  const before = await fileIdentity(path.join(directory, "save.bin"));
  const resource: Extract<HandoffResource, { kind: "directory" }> = {
    ...first(record.resources),
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
  first(current.resources).snapshot_at = "2026-10-13T18:01:00Z";
  asDirectory(first(current.resources)).files = [
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
    first(asDirectory(first(invalid.resources)).files).relative_path = relative_path;
    assert.throws(() => validateHandoff(invalid), /unsafe/);
  }
});

void test("legacy, invalid references and changed expected source fail closed", async (t) => {
  const { record } = await fixture(t);
  assert.throws(() => validateHandoff({ ...record, format_version: 0 }), /recapture/);
  assert.throws(
    () => validateHandoff({ ...record, library: { id: "x", resource_id: "missing" } }),
    /reference/,
  );
  const report = await checkHandoff(record, { expectedRevision: "b".repeat(40) });
  assert.equal(report.status, "incomplete");
  assert.equal(report.completed[0]?.reusable, false);
  record.pull_request = { repository: "boburning/portcove", number: 1388, head: revision };
  for (const status of ["unknown", "changed"] as const) {
    const stale = await checkHandoff(record, { remote: () => ({ status }) });
    assert.equal(stale.status, "incomplete");
    assert.equal(stale.completed[0]?.reusable, false);
  }
});

void test("selected remote readback supersedes draft history and rejects changed/incomplete identities", () => {
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
  const run =
    (value: unknown): NonNullable<Parameters<typeof readSelectedPullRequest>[1]> =>
    (_command, _args, options) => {
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

void test("Unicode summaries remain byte bounded while preserving a failed verdict and totals", async (t) => {
  const { record } = await fixture(t);
  record.outstanding = ["雪".repeat(20000)];
  const report = await checkHandoff(record, { inspect: async () => "unavailable" });
  const rendered = renderHandoff(report, "/local/handoff.json");
  assert.ok(Buffer.byteLength(rendered, "utf8") <= HANDOFF_LIMITS.outputBytes);
  const parsed = object(JSON.parse(rendered));
  assert.equal(parsed.status, "incomplete");
  assert.equal(object(parsed.resource_counts).unavailable, 1);
  assert.equal(parsed.details_omitted, true);
});

function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}
function asDirectory(value: HandoffResource): Extract<HandoffResource, { kind: "directory" }> {
  assert.ok(value.kind === "directory");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

void test("handoff identity and timestamp fields reject coercible JSON arrays", async (t) => {
  const { record } = await fixture(t);
  const resource = first(record.resources);
  assert.ok(resource.kind === "file");
  assert.equal(validateHandoff(record), record, "Validation retains the original custody record");
  for (const malformed of [
    { ...record, revision: [revision] },
    { ...record, captured_at: [captured_at] },
    { ...record, resources: [{ ...resource, snapshot_at: [captured_at] }] },
    { ...record, resources: [{ ...resource, sha256: [resource.sha256] }] },
    {
      ...record,
      pull_request: { repository: ["boburning/portcove"], number: 1388, head: revision },
    },
  ])
    assert.throws(() => validateHandoff(malformed), /Handoff rejected/u);
});
