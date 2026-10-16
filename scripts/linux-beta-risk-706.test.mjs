import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approval706,
  expiry706,
  target706,
  decide706,
  candidate706,
} from "./linux-beta-risk-706.mjs";

import { createHash } from "node:crypto";
import { parseDependencyScan } from "./dependency-security.mjs";

const scannerPolicy = readFileSync(new URL("../deny.toml", import.meta.url), "utf8");
const policyHash = createHash("sha256")
  .update(scannerPolicy.replaceAll("\r\n", "\n"))
  .digest("hex");

const candidate = {
  head: "a".repeat(40),
  lockSha256: "b".repeat(64),
  target: target706,
  features: ["default", "tauri/custom-protocol"],
  productionChanges: "",
  reviewedHead: "c".repeat(40),
};
const approval = {
  approvalUrl: approval706,
  owner: "boburning",
  expiresAt: expiry706,
  approvedAt: "2026-10-15T01:21:44.000Z",
  advisory: "RUSTSEC-2024-0429",
  alias: "GHSA-wrw7-89jp-8q8g",
  package: "glib",
  version: "0.18.5",
  reconfirmedHead: candidate.reviewedHead,
  policySha256: policyHash,
  firstPublicationTag: "v0.1.0-beta.1",
};
const summary = {
  advisories: { errors: 1, warnings: 0, helps: 0, notes: 0 },
  bans: { errors: 0, warnings: 0, helps: 0, notes: 0 },
  licenses: { errors: 0, warnings: 0, helps: 0, notes: 0 },
  sources: { errors: 0, warnings: 0, helps: 0, notes: 0 },
};
const finding = {
  severity: "error",
  code: "unsound",
  advisory: { id: "RUSTSEC-2024-0429", package: "glib" },
  labels: [{ span: "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index" }],
};
function output(errors = [finding], fields = summary) {
  return [...errors.map((fields) => ({ type: "diagnostic", fields })), { type: "summary", fields }]
    .map(JSON.stringify)
    .join("\n");
}
function input() {
  return {
    approval: structuredClone(approval),
    candidate: structuredClone(candidate),
    scan: {
      head: candidate.head,
      lockSha256: candidate.lockSha256,
      completedAt: "2026-10-16T00:00:00.000Z",
      complete: true,
      signal: null,
      error: null,
      exitCode: 1,
      unsoundAll: true,
      configSha256: approval.policySha256,
      sourceConfigSha256: approval.policySha256,
      sourceConfig: scannerPolicy,
      executionConfig: scannerPolicy,
      toolVersion: "cargo-deny 0.20.2",
      scope: "workspace-default-all-targets-all-checks",
      stdout: "",
      stderr: output(),
    },
    releases: [],
    now: "2026-10-16T00:00:00.000Z",
    purpose: "release",
    publicationTag: "v0.1.0-beta.1",
  };
}

test("exact approved finding produces a separate decision while retaining failed scan status", () => {
  const value = input(),
    before = structuredClone(value);
  const result = decide706(value);
  assert.equal(result.disposition, "accepted-risk");
  assert.equal(result.scanExitCode, 1);
  assert.equal(result.scanPassed, false);
  assert.deepEqual(value, before);
});

test("absent, expired, premature and out-of-scope approval cannot authorize a release", () => {
  for (const mutate of [
    (x) => {
      x.approval = null;
    },
    (x) => {
      x.now = expiry706;
    },
    (x) => {
      x.now = "2026-10-14T00:00:00Z";
    },
    (x) => {
      x.approval.approvalUrl = "https://example.com/approval";
    },
    (x) => {
      x.approval.version = "0.18.6";
    },
    (x) => {
      x.approval.owner = "another-owner";
    },
    (x) => {
      x.candidate.target = "aarch64-unknown-linux-gnu";
    },
    (x) => {
      x.candidate.features.push("native-compatibility-qualification");
    },
    (x) => {
      x.publicationTag = "v0.1.0-beta.2";
    },
    (x) => {
      x.approval.firstPublicationTag = null;
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => decide706(value));
  }
});

test("source/dependency drift requires reassessment; unrelated source head changes do not", () => {
  for (const field of ["productionChanges", "reviewedHead"]) {
    const value = input();
    value.candidate[field] = "e".repeat(64);
    assert.throws(() => decide706(value), /reassessment/);
  }
  const value = input();
  value.candidate.head = "f".repeat(40);
  value.scan.head = value.candidate.head;
  assert.equal(decide706(value).candidate, value.candidate.head);
});

test("execution failure, wrong candidate, green/incomplete coverage and extra errors block", () => {
  for (const mutate of [
    (x) => {
      x.scan.completedAt = "2000-01-01T00:00:00Z";
    },
    (x) => {
      x.scan.completedAt = null;
    },
    (x) => {
      x.scan.complete = false;
    },
    (x) => {
      x.scan.signal = "SIGTERM";
    },
    (x) => {
      x.scan.error = "spawn failure";
    },
    (x) => {
      x.scan.exitCode = 2;
    },
    (x) => {
      x.scan.exitCode = 0;
    },
    (x) => {
      x.scan.unsoundAll = false;
    },
    (x) => {
      x.scan.configSha256 = "f".repeat(64);
    },
    (x) => {
      x.scan.toolVersion = "cargo-deny 0.20.3";
    },
    (x) => {
      x.scan.head = "e".repeat(40);
    },
    (x) => {
      x.scan.lockSha256 = "f".repeat(64);
    },
    (x) => {
      x.scan.stderr += "\ntruncated output";
    },
    (x) => {
      x.scan.stderr = output([finding], { advisories: summary.advisories });
    },
    (x) => {
      x.scan.stderr = output([finding, { ...finding, code: "vulnerability" }], {
        ...summary,
        advisories: { ...summary.advisories, errors: 2 },
      });
    },
    (x) => {
      x.scan.stderr = output([
        { ...finding, advisory: { id: "RUSTSEC-2099-0001", package: "glib" } },
      ]);
    },
    (x) => {
      x.scan.stderr = output([
        {
          ...finding,
          labels: [{ span: "glib 0.19.0 registry+https://github.com/rust-lang/crates.io-index" }],
        },
      ]);
    },
    (x) => {
      x.scan.stderr = output(
        [
          finding,
          {
            ...finding,
            severity: "warning",
            code: "vulnerability",
            advisory: { id: "RUSTSEC-2099-0001", package: "another-package" },
          },
        ],
        { ...summary, advisories: { ...summary.advisories, warnings: 1 } },
      );
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => decide706(value));
  }
});

test("all four scanner checks must complete with consistent summary accounting", () => {
  assert.equal(parseDependencyScan("", output()).errors.length, 1);
  assert.throws(() =>
    parseDependencyScan("", output() + "\n" + JSON.stringify({ type: "summary", fields: summary })),
  );
  assert.throws(() => parseDependencyScan("", output([], summary)), /mismatch/);
});

test("qualification cannot allocate a publication and the second tag is always refused", () => {
  const first = {
    id: 1,
    draft: false,
    tag_name: "v0.1.0-beta.1",
    published_at: "2026-10-17T00:00:00Z",
    assets: [{ name: "Portcove_0.1.0-beta.1_amd64.AppImage" }],
  };
  const value = input();
  value.releases = [first];
  value.now = "2026-10-18T00:00:00Z";
  value.scan.completedAt = value.now;
  assert.equal(decide706(value).disposition, "accepted-risk");
  value.publicationTag = "v0.1.0-beta.2";
  assert.throws(() => decide706(value), /first publication tag/);
  value.purpose = "qualification";
  value.approval.firstPublicationTag = null;
  assert.throws(() => decide706(value), /second ordinary Linux/);
  value.releases = []; // Deleted publication still cannot authorize a different pinned tag.
  value.purpose = "release";
  assert.throws(() => decide706(value), /first publication tag/);
  value.purpose = "qualification";
  assert.throws(() => decide706(value), /purpose/);
  value.releases = null;
  assert.throws(() => decide706(value), /inventory/);
});

test("release source review compares the exact candidate against a named reviewed commit", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-706-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, ".github"));
  writeFileSync(path.join(dir, ".github/linux-beta-risk-706.json"), JSON.stringify(approval));
  writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n");
  const metadata = {
    packages: [
      { id: "desktop", name: "portcove-desktop", source: null },
      {
        id: "glib",
        name: "glib",
        version: "0.18.5",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ],
    resolve: {
      nodes: [
        { id: "desktop", features: [], deps: [{ pkg: "glib", dep_kinds: [{ kind: null }] }] },
        { id: "glib", features: [], deps: [] },
      ],
    },
  };
  let changes = "";
  const execute = (name, args) => {
    if (name === "cargo") return JSON.stringify(metadata);
    if (args[0] === "rev-parse") return candidate.head;
    if (args[0] === "status") return "";
    if (args[0] === "show") return "version = 4\n";
    assert.equal(args[2], approval.reconfirmedHead);
    return changes;
  };
  const before = candidate706(dir, execute);
  changes = "crates/portcove-core/src/lib.rs";
  const after = candidate706(dir, execute);
  assert.deepEqual(after.native, before.native);
  assert.equal(after.productionChanges, changes);
  assert.equal(after.reviewedHead, approval.reconfirmedHead);
});
