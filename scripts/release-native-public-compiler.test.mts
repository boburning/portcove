import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { inspectNativeReleaseVerificationCommand } from "./release-native-candidate.mts";
import {
  collectActualPublicWindowsCompilerIdentity,
  requireActualPublicWindowsCompilerIdentity,
} from "./release-native-public-compiler.mts";
import { readReleaseCompilerReportArchive } from "./release-compiler-report-archive.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";

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
});
