import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { inspectNativeReleaseVerificationCommand } from "./release-native-candidate.mts";
import {
  collectActualPublicWindowsCompilerIdentity,
  requireActualPublicWindowsCompilerIdentity,
  inspectPublicCompilerRetainedInput,
  recoverActualPublicWindowsCompilerIdentity,
} from "./release-native-public-compiler.mts";
import { readReleaseCompilerReportArchive } from "./release-compiler-report-archive.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { projectWindowsNsisExecutable } from "./release-compiler-desktop.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

void test("public compiler verifier fixes retained file/workflow/ref/predicate without native or source mutation flags", () => {
  const directory = path.resolve("work/inert-public-compiler"),
    file = path.join(directory, "compiler-result-cli-linux-x86_64.json");
  const expected = {
    source_commit: "a".repeat(40),
    ref: "refs/tags/portcove-fixture-prepared/v0.1.1",
  };
  const args = [
    "attestation",
    "verify",
    file,
    "--hostname",
    "github.com",
    "--repo",
    "boburning/portcove",
    "--signer-workflow",
    "boburning/portcove/.github/workflows/release.yml",
    "--signer-digest",
    expected.source_commit,
    "--source-digest",
    expected.source_commit,
    "--source-ref",
    expected.ref,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--limit",
    "5",
    "--format",
    "json",
  ];
  inspectNativeReleaseVerificationCommand(args, directory, expected);
  assert.throws(() =>
    inspectNativeReleaseVerificationCommand(
      [...args, "--allow-self-hosted-runners"],
      directory,
      expected,
    ),
  );
  assert.throws(() =>
    inspectNativeReleaseVerificationCommand(
      args.map((item) => (item === "boburning/portcove" ? "other/portcove" : item)),
      directory,
      expected,
    ),
  );
  assert.throws(() =>
    inspectNativeReleaseVerificationCommand(
      args.map((item) =>
        item === file ? path.resolve(directory, "../compiler-result-cli-linux-x86_64.json") : item,
      ),
      directory,
      expected,
    ),
  );
});
void test("shared report decoder preserves exact started/result bytes and refuses extra/missing inventory", () => {
  const members = [
    ["compiler-observation-desktop-windows-x86_64.json", Buffer.from("started")],
    ["compiler-result-desktop-windows-x86_64.json", Buffer.from("result")],
  ] as const;
  const decoded = readReleaseCompilerReportArchive(
    createAuditZip(members),
    "windows-x86_64",
    "desktop",
  );
  assert.equal(decoded.initial.toString(), "started");
  assert.equal(decoded.result.toString(), "result");
  assert.throws(() =>
    readReleaseCompilerReportArchive(createAuditZip(members.slice(1)), "windows-x86_64", "desktop"),
  );
  assert.throws(() =>
    readReleaseCompilerReportArchive(
      createAuditZip([...members, ["injected.json", Buffer.from("{}")]]),
      "windows-x86_64",
      "desktop",
    ),
  );
  assert.throws(() =>
    readReleaseCompilerReportArchive(createAuditZip(members), "linux-x86_64", "desktop"),
  );
});
void test("raw hosted/local compiler summaries cannot appoint the actual parent-owned input proof", async () => {
  const raw = {
    kind: "actual-public-journey-pair",
    evidence_scope: "github.com",
    authority: "none",
  };
  await assert.rejects(
    collectActualPublicWindowsCompilerIdentity(raw, "candidate"),
    /actual parent\/public Tough pair/,
  );
  await assert.rejects(
    requireActualPublicWindowsCompilerIdentity({
      ...raw,
      kind: "actual-local-public-compiler-input",
    }),
    /actual local parent compiler input custody/,
  );
  await assert.rejects(
    recoverActualPublicWindowsCompilerIdentity(raw, "prior"),
    /actual parent\/public Tough pair/,
  );
});

void test("retained compiler inventory binds exact original admitted bytes without accepting paths or authority fields", () => {
  const raw = {
    schema_version: 1,
    identity: {
      executable: projectWindowsNsisExecutable(
        Buffer.from("prefix__TAURI_BUNDLE_TYPE_VAR_UNKsuffix"),
      ),
      package: { filename: "Portcove_1.0.0_x64-setup.exe", bytes: 100, sha256: "a".repeat(64) },
      source_commit: "b".repeat(40),
      source_tree: "c".repeat(40),
      run_id: "123",
      run_attempt: 1,
      producer_job_id: 456,
      report_sha256: "d".repeat(64),
    },
    files: [{ path: "public-inputs/windows-x86_64.zip", bytes: 42, sha256: "e".repeat(64) }],
  };
  const parsed = inspectPublicCompilerRetainedInput(raw);
  assert.deepEqual(parsed.identity, raw.identity);
  const admitted = { ...parsed.identity, retained_input_sha256: digest(raw) };
  const changed = structuredClone(raw);
  changed.files[0]!.sha256 = "f".repeat(64);
  assert.notEqual(
    digest(admitted),
    digest({ ...parsed.identity, retained_input_sha256: digest(changed) }),
  );
  for (const name of [
    "../outside",
    "public-inputs/../outside",
    "/absolute",
    "C:/absolute",
    "x\\outside",
    ".",
    "..",
  ])
    assert.throws(() =>
      inspectPublicCompilerRetainedInput({ ...raw, files: [{ ...raw.files[0], path: name }] }),
    );
  assert.throws(() => inspectPublicCompilerRetainedInput({ ...raw, authority: "accepted" }));
  assert.throws(() =>
    inspectPublicCompilerRetainedInput({
      ...raw,
      files: [...raw.files, { ...raw.files[0], path: "PUBLIC-INPUTS/windows-x86_64.zip" }],
    }),
  );
  assert.throws(() =>
    inspectPublicCompilerRetainedInput({
      ...raw,
      identity: { ...raw.identity, source_commit: "wrong" },
    }),
  );
});
