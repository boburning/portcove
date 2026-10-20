import assert from "node:assert/strict";
import test from "node:test";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import {
  inspectSelectedNativeCandidate,
  acquireActualNativeCandidate,
  requireActualNativeCandidate,
  inspectNativeSourceCommand,
} from "./release-native-candidate.mts";

void test("selection reconstructs exact real-package identities without native or admission authority", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const facts = {
    assembly: f.request,
    checkpoint: "c".repeat(40),
    archives: ["windows-x86_64", "linux-x86_64"].map((platform, index) => ({
      platform,
      artifact_id: 100 + index,
      bytes: 123,
      sha256: "d".repeat(64),
    })),
  };
  for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
    const file = f.request.files.find(
      (entry) => entry.platform_label === platform && /(?:\.exe|\.AppImage)$/u.test(entry.filename),
    );
    assert.ok(file);
    const bytes = f.contents.get(`${platform}/${file.filename}`);
    assert.ok(bytes);
    const retained = { identity: file, bytes };
    const selected = await inspectSelectedNativeCandidate(facts, platform, retained);
    assert.equal(selected.candidate.source_commit, f.request.source_commit);
    assert.equal(selected.candidate.source_tree, f.request.source_tree);
    assert.equal(selected.candidate.run_id, f.request.run_id);
    assert.equal(selected.candidate.package.sha256, file.sha256);
    assert.equal(selected.authority, "none");
    assert.equal(selected.scope, "integrity-only");
    for (const changed of [
      { ...retained, bytes: Buffer.from("changed") },
      { ...retained, identity: { ...file, sha256: "e".repeat(64) } },
      { ...retained, identity: { ...file, platform_label: "foreign" } },
    ])
      await assert.rejects(inspectSelectedNativeCandidate(facts, platform, changed));
    for (const archives of [
      facts.archives.slice(0, 1),
      [facts.archives[0]!, facts.archives[0]!],
      facts.archives.map((entry) => ({ ...entry, artifact_id: 0 })),
    ])
      await assert.rejects(
        inspectSelectedNativeCandidate({ ...facts, archives }, platform, retained),
      );
  }
});

void test("credentialled source routes admit only exact provider reads and query bodies", () => {
  const args = [
    "api",
    "--include",
    "repos/boburning/portcove/actions/runs/123",
    "--method",
    "GET",
    "--hostname",
    "github.com",
  ];
  assert.equal(inspectNativeSourceCommand(args).authority, "none");
  const query = ["api", "graphql", "--include", "--input", "-", "--hostname", "github.com"];
  inspectNativeSourceCommand(
    query,
    JSON.stringify({ query: "query($id:ID!){node(id:$id){id}}", variables: { id: "fixed" } }),
  );
  for (const changed of [
    args.map((value) => (value === "GET" ? "POST" : value)),
    args.map((value) => (value === "github.com" ? "foreign.invalid" : value)),
    args.map((value) => (value.startsWith("repos/") ? "repos/foreign/portcove" : value)),
    [...args, "--jq", ".token"],
    ["auth", "token"],
  ])
    assert.throws(() => inspectNativeSourceCommand(changed));
  assert.throws(() =>
    inspectNativeSourceCommand(
      query,
      JSON.stringify({ query: "mutation{deleteRepository{clientMutationId}}" }),
    ),
  );
  assert.throws(() => inspectNativeSourceCommand(args, "unexpected body"));
});

void test("imported parent and selected descriptors cannot start actual source collection", async () => {
  for (const raw of [{}, { kind: "actual-native-candidate-selection", accepted: true }]) {
    await assert.rejects(acquireActualNativeCandidate(raw), /actual installed native parent/);
    await assert.rejects(requireActualNativeCandidate(raw), /actual parent-owned/);
  }
});
