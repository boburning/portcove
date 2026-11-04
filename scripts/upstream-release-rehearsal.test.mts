import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  inspectRehearsalDraftReadback,
  inspectRehearsalFeed,
  inspectRehearsalManifest,
  rehearsalVersions,
  rehearsalPackageConfiguration,
} from "./upstream-release-rehearsal.mts";

const expected = { source: "a".repeat(40), run_id: "12345", run_attempt: 2 };
function fixture() {
  return {
    ...expected,
    scope: "disposable-nonproduction",
    version: rehearsalVersions(expected).candidate,
    files: [
      `Portcove_${rehearsalVersions(expected).candidate}_x64-setup.exe`,
      "fixture.patch",
      "windows-compatibility.json",
      `portcove-cli-${rehearsalVersions(expected).candidate}-windows-x86_64.zip`,
    ].map((name) => ({ name, bytes: 10, sha256: "b".repeat(64) })),
  };
}
void test("transferred manifest refuses source/attempt/scope drift and ambiguous asset sets", () => {
  assert.equal(inspectRehearsalManifest(fixture(), expected).files.length, 4);
  for (const delta of [
    { source: "c".repeat(40) },
    { run_id: "12346" },
    { run_attempt: 1 },
    { scope: "production" },
    { version: "0.2.0" },
    { unexpected: true },
    { files: [] },
    { files: [...fixture().files, ...fixture().files, ...fixture().files] },
    { files: [{ ...fixture().files[0], name: "../payload.exe" }] },
    { files: [{ ...fixture().files[0], bytes: 257 * 1024 ** 2 }] },
    { files: [{ ...fixture().files[0], sha256: "x".repeat(64) }] },
  ])
    assert.throws(() => inspectRehearsalManifest({ ...fixture(), ...delta }, expected));
});
void test("workflow separates builder, attester, disposable signer and draft writer on fresh standard runners", () => {
  const text = readFileSync(
    new URL("../.github/workflows/upstream-release-rehearsal.yml", import.meta.url),
    "utf8",
  );
  type Step = { uses?: string; with?: Record<string, string | boolean> };
  type Job = {
    "runs-on": string;
    "timeout-minutes": number;
    "continue-on-error"?: boolean;
    environment?: string;
    permissions?: Record<string, string>;
    needs?: string | string[];
    steps: Step[];
  };
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency.group, "portcove-upstream-release-rehearsal");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.package!["runs-on"], "windows-2025");
  assert.equal(workflow.jobs.package!.permissions, undefined);
  assert.deepEqual(workflow.jobs.provenance!.needs, "package");
  assert.deepEqual(workflow.jobs.sign!.needs, ["package", "provenance"]);
  assert.deepEqual(workflow.jobs.draft!.needs, ["sign", "installed"]);
  assert.deepEqual(workflow.jobs.installed!.needs, ["package", "sign"]);
  let total = 0;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    total += job["timeout-minutes"];
    assert.ok(["windows-2025", "ubuntu-22.04"].includes(job["runs-on"]));
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job.environment, undefined);
    if (name !== "draft") assert.notEqual(job.permissions?.contents, "write");
    assert.equal(
      job.steps.some((s) => /cache/.test(s.uses ?? "")),
      false,
    );
    for (const s of job.steps)
      if (s.uses?.includes("/checkout@")) {
        assert.equal(s.with!.ref, "${{ github.sha }}");
        assert.equal(s.with!["persist-credentials"], false);
      }
  }
  assert.ok(total <= 140);
  assert.doesNotMatch(text, /secrets\.|self-hosted|release edit|--clobber/);
  assert.match(text, /--config \$packageConfiguration/u);
  assert.doesNotMatch(text, /--config ['"]\{/u);
  assert.deepEqual(rehearsalPackageConfiguration(), {
    bundle: { createUpdaterArtifacts: false, windows: { nsis: { installMode: "currentUser" } } },
  });
  assert.equal(
    workflow.jobs.provenance!.steps.at(-1)!.with!["subject-path"],
    "unsigned/rehearsal.json",
  );
  assert.ok(
    workflow.jobs.sign!.steps.some(
      (s) => s.with?.["subject-path"] === "work/upstream-signed/rehearsal.json",
    ),
  );
});

void test("public feed transfer refuses traversal, links-by-shape, duplicates and excessive data before writes", () => {
  const valid = [
    { path: "metadata/1.root.json", text: "{}" },
    { path: "targets/abc.releases/0.0.0/record.json", text: "{}" },
  ];
  assert.deepEqual(inspectRehearsalFeed(valid), valid);
  for (const value of [
    [],
    [...valid, valid[0]],
    [{ path: "metadata/../key", text: "{}" }],
    [{ path: "/metadata/root.json", text: "{}" }],
    [{ path: "private/key", text: "{}" }],
    [{ path: "metadata/root.json", text: "x".repeat(2 * 1024 ** 2 + 1) }],
    [{ path: "metadata/root.json", text: "{}", link: "../private" }],
  ])
    assert.throws(() => inspectRehearsalFeed(value));
});

void test("final draft proof observes publication/tag/asset drift instead of asserting draft status", () => {
  const files = fixture().files;
  const tag = `v${fixture().version}`;
  const expectedDraft = { id: 42, tag, source: expected.source, files };
  const release = {
    id: 42,
    tag_name: tag,
    target_commitish: expected.source,
    draft: true,
    prerelease: true,
  };
  const ref = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: expected.source } };
  const assets = files.map((f) => ({ name: f.name, size: f.bytes, digest: `sha256:${f.sha256}` }));
  assert.equal(inspectRehearsalDraftReadback(release, ref, assets, expectedDraft).draft, true);
  for (const delta of [
    { draft: false },
    { prerelease: false },
    { id: 43 },
    { tag_name: "wrong" },
    { target_commitish: "c".repeat(40) },
  ])
    assert.throws(() =>
      inspectRehearsalDraftReadback({ ...release, ...delta }, ref, assets, expectedDraft),
    );
  assert.throws(() =>
    inspectRehearsalDraftReadback(
      release,
      { ...ref, object: { type: "commit", sha: "c".repeat(40) } },
      assets,
      expectedDraft,
    ),
  );
  for (const changed of [
    assets.slice(1),
    [...assets, assets[0]],
    assets.map((a) => ({ ...a, digest: "sha256:" + "c".repeat(64) })),
  ])
    assert.throws(() => inspectRehearsalDraftReadback(release, ref, changed, expectedDraft));
});
