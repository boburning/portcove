import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildWorkflowProvenance,
  parseProvenanceArchive,
  validateWorkflowProvenance,
} from "./workflow-provenance.mjs";

const sha = (letter) => letter.repeat(40);
const environment = {
  GITHUB_WORKFLOW_SHA: sha("a"),
  GITHUB_SHA: sha("b"),
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "3",
  GITHUB_REPOSITORY: "example/repo",
  GITHUB_WORKFLOW_REF: "example/repo/.github/workflows/ci.yml@refs/pull/7/merge",
  GITHUB_EVENT_NAME: "pull_request",
  PORTCOVE_HEAD_SHA: sha("c"),
  PORTCOVE_PLAN_DIGEST: "d".repeat(64),
  PORTCOVE_PLAN_MODE: "qualification",
  PORTCOVE_CALLER: "pull-request",
  GITHUB_JOB: "provenance",
};
const build = (overrides = {}) =>
  buildWorkflowProvenance({
    workflow: "ci.yml",
    mode: "ci",
    desiredRunner: "ubuntu-latest",
    workflowContents: "name: CI\n",
    desired: {
      node: "24.21.0",
      package_manager: "12.4.1",
      rust: "1.98.1",
      build_configuration: { ci: true },
    },
    observed: {
      node: "24.21.0",
      package_manager: "12.4.1",
      rust: "1.98.1",
      cargo: "1.98.1",
      runner: { os: "Linux", architecture: "X64" },
      build_configuration: { ci: true },
    },
    environment,
    checkoutSha: sha("b"),
    ...overrides,
  });
const validationContext = {
  runId: 42,
  attempt: 3,
  headSha: sha("c"),
  repository: "example/repo",
  workflow: "ci.yml",
  event: "pull_request",
};

function storedZip(name, contents) {
  const data = Buffer.from(contents);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

test("binds official workflow source context, checked-out code, and exact configurations", () => {
  const record = build();
  assert.equal(record.workflow.source_sha, sha("a"));
  assert.equal(record.checkout.sha, sha("b"));
  assert.equal(record.checkout.head_sha, sha("c"));
  assert.equal(record.format_version, 2);
  assert.equal(record.validation.plan_digest, "d".repeat(64));
  assert.equal(record.validation.caller, "pull-request");
  assert.equal(record.job_toolchains.length, 1);
  assert.equal(
    record.workflow.content_sha256,
    createHash("sha256").update("name: CI\n").digest("hex"),
  );
  assert.ok(Object.values(record.matches).every(Boolean));
  assert.equal(validateWorkflowProvenance(record, validationContext), record);
  assert.throws(
    () => build({ observed: { ...build().observed, node: "25.0.0" } }),
    /differs from desired/u,
  );
});

test("rejects substituted workflow refs, checkout SHAs, and artifact identities", () => {
  assert.throws(
    () =>
      build({
        environment: { ...environment, GITHUB_WORKFLOW_REF: "example/repo/other.yml@main" },
      }),
    /WORKFLOW_REF/u,
  );
  assert.throws(() => build({ checkoutSha: sha("c") }), /does not match GITHUB_SHA/u);
  assert.throws(
    () => validateWorkflowProvenance(build(), { ...validationContext, attempt: 2 }),
    /identity/u,
  );
});

test("rejects incomplete match evidence and substituted cohort identities", () => {
  const withoutMatches = build();
  delete withoutMatches.matches;
  assert.throws(() => validateWorkflowProvenance(withoutMatches, validationContext), /identity/u);
  const substitutedCohort = build();
  substitutedCohort.equivalent_cohort = "f".repeat(64);
  assert.throws(
    () => validateWorkflowProvenance(substitutedCohort, validationContext),
    /identity/u,
  );
  assert.throws(
    () =>
      validateWorkflowProvenance(build(), {
        ...validationContext,
        workflow: "release.yml",
      }),
    /identity/u,
  );
});

test("rejects missing plan, caller, and per-job toolchain identity", () => {
  assert.throws(() => build({ validationPlanDigest: "missing" }), /plan digest/u);
  assert.throws(() => build({ caller: "Bad caller" }), /caller/u);
  const missingJobs = build();
  missingJobs.job_toolchains = [];
  assert.throws(() => validateWorkflowProvenance(missingJobs, validationContext), /identity/u);
});

test("extracts exactly one bounded provenance JSON file from an artifact ZIP", () => {
  const record = build();
  assert.deepEqual(
    parseProvenanceArchive(storedZip("workflow-provenance.json", JSON.stringify(record))),
    record,
  );
  assert.throws(() => parseProvenanceArchive(storedZip("other.json", "{}")), /one JSON/u);
});
