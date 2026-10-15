import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approval706,
  expiry706,
  target706,
  decide706,
  parseScan706,
  candidate706,
} from "./linux-beta-risk-706.mjs";

const candidate = {
  head: "a".repeat(40),
  lockSha256: "b".repeat(64),
  target: target706,
  features: ["default", "tauri/custom-protocol"],
  inputsSha256: "c".repeat(64),
  dependenciesSha256: "d".repeat(64),
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
  inputsSha256: candidate.inputsSha256,
  dependenciesSha256: candidate.dependenciesSha256,
  policySha256: "e".repeat(64),
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
      complete: true,
      signal: null,
      error: null,
      exitCode: 1,
      unsoundAll: true,
      configSha256: approval.policySha256,
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
  for (const field of ["inputsSha256", "dependenciesSha256"]) {
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
  assert.equal(parseScan706("", output()).errors.length, 1);
  assert.throws(() =>
    parseScan706("", output() + "\n" + JSON.stringify({ type: "summary", fields: summary })),
  );
  assert.throws(() => parseScan706("", output([], summary)), /mismatch/);
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
  assert.equal(decide706(value).purpose, "qualification");
  value.releases = null;
  assert.throws(() => decide706(value), /inventory/);
});

test("candidate fingerprints include material source, manifests, build scripts and toolchain/configuration", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-706-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contents = new Map([
    ["Cargo.toml", '[workspace.package]\nversion = "0.1.0-beta.1"\n'],
    ["rust-toolchain.toml", '[toolchain]\nchannel = "1.98.1"\n'],
    [".cargo/config.toml", "[build]\nrustflags = []\n"],
    ["crates/portcove-core/build.rs", "fn main() {}\n"],
    ["crates/portcove-core/Cargo.toml", '[package]\nname = "portcove-core"\n'],
    ["apps/desktop/src-tauri/Cargo.toml", '[package]\nname = "portcove-desktop"\n'],
    ["apps/desktop/src-tauri/src/main.rs", "fn main() {}\n"],
  ]);
  for (const [name, text] of contents) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n");
  writeFileSync(
    path.join(dir, "apps/desktop/src-tauri/tauri.conf.json"),
    '{"version":"0.1.0-beta.1","app":{}}',
  );
  const metadata = {
    packages: [
      { id: "desktop", name: "portcove-desktop", source: null, version: "0.1.0-beta.1" },
      {
        id: "glib",
        name: "glib",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        version: "0.18.5",
      },
    ],
    resolve: {
      nodes: [
        { id: "desktop", features: [], deps: [{ pkg: "glib", dep_kinds: [{ kind: null }] }] },
        { id: "glib", features: ["default"], deps: [] },
      ],
    },
  };
  const execute = (name, args) => {
    if (name === "cargo") return JSON.stringify(metadata);
    if (args[0] === "rev-parse") return candidate.head;
    if (args[0] === "diff") return "";
    if (args[0] === "ls-files") return [...contents.keys()].join("\0");
    throw new Error("unexpected command");
  };
  const originalSha = process.env.GITHUB_SHA;
  delete process.env.GITHUB_SHA;
  t.after(() => {
    if (originalSha !== undefined) process.env.GITHUB_SHA = originalSha;
  });
  const before = candidate706(dir, execute);
  for (const [name, text] of contents) {
    writeFileSync(path.join(dir, name), text + "# changed relevant input\n");
    assert.notEqual(candidate706(dir, execute).inputsSha256, before.inputsSha256, name);
    writeFileSync(path.join(dir, name), text);
  }
  writeFileSync(
    path.join(dir, "Cargo.toml"),
    contents.get("Cargo.toml").replace("beta.1", "beta.2"),
  );
  assert.equal(candidate706(dir, execute).inputsSha256, before.inputsSha256);
  writeFileSync(path.join(dir, "unrelated-document.md"), "unrelated\n");
  assert.equal(candidate706(dir, execute).inputsSha256, before.inputsSha256);
});
