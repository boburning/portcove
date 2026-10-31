import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { inspectRiskVersionPreparation706 } from "./linux-beta-risk-706-preparation.mts";
import { pathToFileURL } from "node:url";
import {
  approval706,
  expiry706,
  target706,
  decide706,
  candidate706,
  validateApproval706,
  assessDispatchedBuild706,
  dispatchedBuildAssessment706,
  inspectCompilerRiskAssessment706,
  releaseAuditDisposition,
} from "./linux-beta-risk-706.mts";

import { createHash } from "node:crypto";
import { parseDependencyScan } from "./dependency-security.mts";

const scannerPolicy = readFileSync(new URL("../deny.toml", import.meta.url), "utf8");

void test("ordinary risk readers do not load optional release-policy dependencies", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-706-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = path.join(dir, "reader.mts");
  writeFileSync(
    helper,
    readFileSync(new URL("./linux-beta-risk-706-preparation.mts", import.meta.url)),
  );
  // Exact helper bytes in a fresh directory with no dependency tree or parent
  // verifier. A future eager import fails before the actual ordinary assertion.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict'; const m=await import(${JSON.stringify(pathToFileURL(helper).href)}); assert.equal(await m.inspectRiskVersionPreparation706('a'.repeat(40),()=> 'ordinary commit\\n'),null);`,
    ],
    {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );
});

void test("new controller bundle imports cannot execute scanner or risk CLIs", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-risk-cli-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [index, name] of ["linux-beta-risk-706.mts", "dependency-security.mts"].entries()) {
    const original = new URL(`./${name}`, import.meta.url);
    // The installed bundler folds import.meta.url to its entry. Preserve the
    // whole actual module and imports, changing only its physical entry name.
    const copied = readFileSync(original, "utf8").replace(
      /from "([.][^"]+)"/gu,
      (_whole: string, relative: string) => `from "${new URL(relative, original).href}"`,
    );
    const entry = path.join(dir, `fixed-controller-${index}.mts`);
    writeFileSync(entry, copied);
    const result = spawnSync(process.execPath, [entry], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

void test("only the complete deterministic version transform projects native review to its actual source", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-706-prepared-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args: readonly string[], input?: string) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      input,
      windowsHide: true,
      timeout: 15000,
    });
  git(["init", "-q"]);
  git(["config", "user.name", "Risk projection fixture"]);
  git(["config", "user.email", "fixture@portcove.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  const files = {
    "Cargo.toml":
      '[workspace]\nmembers = ["apps/desktop/src-tauri"]\n[workspace.package]\nversion = "0.1.0"\n',
    "apps/desktop/src-tauri/Cargo.toml":
      '[package]\nname = "portcove-desktop"\nversion.workspace = true\n',
    "Cargo.lock":
      'version = 4\n\n[[package]]\nname = "portcove-desktop"\nversion = "0.1.0"\n\n[[package]]\nname = "third-party"\nversion = "0.1.0"\nsource = "registry+https://example.invalid"\n',
    "apps/desktop/package.json": '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json":
      '{\n  "version": "0.1.0",\n  "identifier": "fixture.example"\n}\n',
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
  }
  git(["add", "."]);
  git(["commit", "-qm", "reviewed native baseline"]);
  const baseline = git(["rev-parse", "HEAD"]).trim();
  mkdirSync(path.join(dir, ".github"));
  writeFileSync(
    path.join(dir, ".github/linux-beta-risk-706.json"),
    JSON.stringify({ ...approval, reconfirmedHead: baseline }),
  );
  git(["add", "."]);
  git(["commit", "-qm", "source opportunity"]);
  const source = git(["rev-parse", "HEAD"]).trim();
  const prepared = await prepareReleaseVersion(
    dir,
    {
      source_commit: source,
      reviewed_commit: source,
      base_version: "0.1.0",
      change: "patch",
      compatibility: "compatible",
    },
    ["0.1.0"],
  );
  const projected = await inspectRiskVersionPreparation706(prepared.prepared_commit, git);
  assert.equal(projected?.source_commit, source);
  assert.equal(projected?.prepared_commit, prepared.prepared_commit);
  assert.equal(await inspectRiskVersionPreparation706(source, git), null);
  assert.match(git(["diff", "--name-only", baseline, prepared.prepared_commit]), /Cargo.lock/u);
  assert.equal(
    git([
      "diff",
      "--name-only",
      baseline,
      projected.source_commit,
      "--",
      "Cargo.toml",
      "Cargo.lock",
      "apps/desktop/src-tauri",
    ]),
    "",
  );
  git(["checkout", "--detach", "-q", prepared.prepared_commit]);
  const inheritedSha = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = prepared.prepared_commit;
  try {
    const actual = await candidate706(dir, (name, args) => {
      if (name === "git") {
        const result = git(args);
        return ["show", "cat-file"].includes(args[0]!) ? result : result.trim();
      }
      assert.equal(name, "cargo");
      return JSON.stringify({
        packages: [
          { id: "desktop", name: "portcove-desktop", version: prepared.version, source: null },
        ],
        resolve: { nodes: [{ id: "desktop", features: [], deps: [] }] },
      });
    });
    assert.equal(actual.head, prepared.prepared_commit);
    assert.equal(actual.productionChanges, "");
    assert.equal(
      actual.lockSha256,
      createHash("sha256")
        .update(git(["show", `${prepared.prepared_commit}:Cargo.lock`]))
        .digest("hex"),
    );
    assert.notEqual(
      actual.lockSha256,
      createHash("sha256").update(files["Cargo.lock"]).digest("hex"),
    );
    assert.equal(actual.versionPreparation?.source_commit, source);
  } finally {
    if (inheritedSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = inheritedSha;
  }
  git(["checkout", "--detach", "-q", source]);

  // Preserve the original actor, date, intent and message while changing an
  // actual dependency. A preparation-shaped commit cannot hide that change.
  git(["read-tree", prepared.prepared_commit]);
  const forgedLock = git(["show", `${prepared.prepared_commit}:Cargo.lock`]).replace(
    'name = "third-party"\nversion = "0.1.0"',
    'name = "third-party"\nversion = "9.9.9"',
  );
  const blob = git(["hash-object", "-w", "--stdin"], forgedLock).trim();
  git(["update-index", "--cacheinfo", `100644,${blob},Cargo.lock`]);
  const forgedTree = git(["write-tree"]).trim();
  const raw = git(["cat-file", "commit", prepared.prepared_commit]).replace(
    /^tree [a-f0-9]{40}/u,
    `tree ${forgedTree}`,
  );
  const forged = git(["hash-object", "-w", "-t", "commit", "--stdin"], raw).trim();
  await assert.rejects(
    () => inspectRiskVersionPreparation706(forged, git),
    /prepared|version|differ/u,
  );

  // A genuinely changed original source remains visible, even with a valid
  // deterministic preparation. There is no approval-baseline advancement.
  git(["read-tree", source]);
  writeFileSync(path.join(dir, "apps/desktop/src-tauri/native.rs"), "changed native behavior\n");
  git(["add", "apps/desktop/src-tauri/native.rs"]);
  git(["commit", "-qm", "unreviewed native change"]);
  const changed = git(["rev-parse", "HEAD"]).trim();
  const second = await prepareReleaseVersion(
    dir,
    {
      source_commit: changed,
      reviewed_commit: changed,
      base_version: "0.1.0",
      change: "minor",
      compatibility: "compatible",
    },
    ["0.1.0"],
  );
  const changedProjection = await inspectRiskVersionPreparation706(second.prepared_commit, git);
  assert.match(
    git(["diff", "--name-only", baseline, changedProjection!.source_commit]),
    /native.rs/u,
  );
});
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
function output(errors: readonly unknown[] = [finding], fields: unknown = summary) {
  return [...errors.map((fields) => ({ type: "diagnostic", fields })), { type: "summary", fields }]
    .map((value) => JSON.stringify(value))
    .join("\n");
}
interface PublishedReleaseFixture {
  id: number;
  draft: boolean;
  tag_name: string;
  published_at: string;
  assets: { name: string }[];
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
      signal: null as NodeJS.Signals | null,
      error: null as string | null,
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
    releases: [] as PublishedReleaseFixture[],
    now: "2026-10-16T00:00:00.000Z",
    purpose: "release",
    publicationTag: "v0.1.0-beta.1",
  };
}

void test("dispatched build measures changed native source without appointing a risk waiver", () => {
  const value = input();
  const buildCandidate = {
    ...value.candidate,
    productionChanges: "apps/desktop/src-tauri/src/application_update_apply.rs",
    native: [{ id: "glib@0.18.5:registry+https://example.invalid", features: [] }],
  };
  const result = assessDispatchedBuild706({
    candidate: buildCandidate,
    scan: value.scan,
    policy: scannerPolicy,
    now: value.now,
  });
  assert.equal(result.scanPassed, false);
  assert.equal(result.scanExitCode, 1);
  assert.equal(result.knownFinding, "RUSTSEC-2024-0429");
  assert.equal(result.authority, "none");
  assert.equal(result.releaseAuthorization, "not-evaluated");
  assert.equal(result.sourceReview, "not-authorized");
  assert.equal(result.riskAuthorization, "pending-protected-controller-assessment");
  assert.throws(() => decide706({ ...value, candidate: buildCandidate }), /reassessment/u);
  assert.throws(
    () =>
      assessDispatchedBuild706({
        candidate: buildCandidate,
        scan: { ...value.scan, head: "f".repeat(40) },
        policy: scannerPolicy,
        now: value.now,
      }),
    /exact-source/u,
  );
  assert.throws(
    () =>
      assessDispatchedBuild706({
        candidate: buildCandidate,
        scan: value.scan,
        policy: scannerPolicy,
        now: "2026-10-16T00:16:00.000Z",
      }),
    /exact-source/u,
  );
  assert.throws(
    () =>
      assessDispatchedBuild706({
        candidate: {
          ...buildCandidate,
          native: [buildCandidate.native[0], buildCandidate.native[0]],
        },
        scan: value.scan,
        policy: scannerPolicy,
        now: value.now,
      }),
    /graph/u,
  );
  const extra = structuredClone(value.scan);
  extra.stderr = output(
    [finding, { ...finding, advisory: { id: "RUSTSEC-OTHER", package: "other" } }],
    { ...summary, advisories: { ...summary.advisories, errors: 2 } },
  );
  assert.throws(
    () =>
      assessDispatchedBuild706({
        candidate: buildCandidate,
        scan: extra,
        policy: scannerPolicy,
        now: value.now,
      }),
    /blocking finding/u,
  );
});

void test("Windows release audit dispatch retains the full scan without Linux approval or a native graph", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-windows-release-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = input();
  const lock = "retained full-workspace lock\n";
  writeFileSync(path.join(dir, "Cargo.lock"), lock);
  writeFileSync(path.join(dir, "deny.toml"), scannerPolicy);
  const scan = {
    ...value.scan,
    lockSha256: createHash("sha256").update(lock).digest("hex"),
  };
  const assess = (observed: unknown = scan) =>
    releaseAuditDisposition({
      root: dir,
      head: value.candidate.head,
      scan: observed,
      environment: {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        PORTCOVE_RELEASE_PROFILE: "initial-beta-windows-x86_64-v1",
      },
      now: value.now,
    });
  // No .git, Linux approval file, reviewed native baseline or cargo metadata
  // exists here. Execute the same disposition function used by the real audit.
  const result = await assess();
  assert.equal(result.suffix, "build-assessment.json");
  assert.ok("release_profile" in result.decision);
  assert.equal(result.decision.authority, "none");
  assert.equal(result.decision.releaseAuthorization, "not-evaluated");
  assert.equal(result.decision.scanPassed, false);
  assert.equal(result.decision.scanExitCode, 1);
  assert.equal(result.decision.knownFinding, "RUSTSEC-2024-0429");
  assert.equal(result.decision.release_profile, "initial-beta-windows-x86_64-v1");
  assert.equal(result.decision.scanScope, "workspace-default-all-targets-all-checks");
  assert.equal("dependencyGraphSha256" in result.decision, false);
  for (const changed of [
    { head: "f".repeat(40) },
    { lockSha256: "f".repeat(64) },
    { completedAt: "2026-10-15T23:44:59.000Z" },
    { completedAt: "2026-10-16T00:00:01.000Z" },
    { complete: false },
    { scope: "Windows-only" },
    { executionConfig: "changed" },
    { exitCode: 0 },
  ])
    await assert.rejects(() => assess({ ...scan, ...changed }));
  const warning = {
    severity: "warning",
    code: "unmaintained",
    advisory: { id: "RUSTSEC-2024-0370", package: "proc-macro-error" },
  };
  const warnings = (entry: unknown) => ({
    ...scan,
    stderr: output([finding, entry], {
      ...summary,
      advisories: { ...summary.advisories, warnings: 1 },
    }),
  });
  await assess(warnings(warning));
  await assert.rejects(
    () =>
      assess(
        warnings({
          ...warning,
          advisory: { ...warning.advisory, id: "RUSTSEC-OTHER" },
        }),
      ),
    /another advisory/u,
  );
  await assert.rejects(
    () => assess(warnings({ ...warning, code: "changed" })),
    /another advisory/u,
  );
  const clean = await assess({
    ...scan,
    exitCode: 0,
    stderr: output([], {
      ...summary,
      advisories: { errors: 0, warnings: 0, notes: 0, helps: 0 },
    }),
  });
  assert.ok("release_profile" in clean.decision);
  assert.equal(clean.decision.scanPassed, true);
  assert.equal(clean.decision.releaseAuthorization, "not-evaluated");
  for (const environment of [
    { GITHUB_EVENT_NAME: "push", PORTCOVE_RELEASE_PROFILE: "initial-beta-windows-x86_64-v1" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", PORTCOVE_RELEASE_PROFILE: "full" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", PORTCOVE_RELEASE_PROFILE: "initial-beta-win-linux" },
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PORTCOVE_RELEASE_PROFILE: "initial-beta-windows-x86_64-v2",
    },
  ]) {
    await assert.rejects(
      () =>
        releaseAuditDisposition({
          root: dir,
          head: value.candidate.head,
          scan,
          environment,
          now: value.now,
        }),
      /git|repository/u,
    );
  }
});

void test("strict clean remediation remains build-only without requiring an exception profile", () => {
  const value = input();
  const clean = {
    ...value.scan,
    exitCode: 0,
    stderr: output([], { ...summary, advisories: { errors: 0, warnings: 0, notes: 0, helps: 0 } }),
  };
  const candidate = {
    ...value.candidate,
    native: [{ id: "glib@0.99.0:registry+https://example.invalid", features: [] }],
  };
  const result = assessDispatchedBuild706({
    candidate,
    scan: clean,
    policy: scannerPolicy,
    now: value.now,
  });
  assert.equal(result.scanPassed, true);
  assert.equal(result.authority, "none");
  assert.equal(result.releaseAuthorization, "not-evaluated");
  assert.throws(
    () =>
      assessDispatchedBuild706({
        candidate: {
          ...candidate,
          native: [{ id: "glib@0.18.5:registry+https://example.invalid", features: [] }],
        },
        scan: clean,
        policy: scannerPolicy,
        now: value.now,
      }),
    /affected compiler graph/u,
  );
});

void test("build assessment routing cannot replace the legacy tag-push decision", () => {
  assert.equal(
    dispatchedBuildAssessment706({
      GITHUB_EVENT_NAME: "push",
      PORTCOVE_RELEASE_PROFILE: "initial-beta-win-linux",
    }),
    false,
  );
  assert.equal(
    dispatchedBuildAssessment706({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PORTCOVE_RELEASE_PROFILE: "full",
    }),
    false,
  );
  assert.equal(
    dispatchedBuildAssessment706({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PORTCOVE_RELEASE_PROFILE: "initial-beta-win-linux",
    }),
    true,
  );
  const value = input();
  assert.throws(
    () => decide706({ ...value, publicationTag: "v0.1.0-beta.2" }),
    /first publication tag/u,
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const authorize = workflow.slice(workflow.indexOf("  authorize_publication:"));
  assert.match(authorize, /github.event_name == 'push'/u);
  assert.match(authorize, /linux-beta-risk-706.mts check/u);
});

void test("compiler scanner subject binds raw FAIL, exact source and producing-job clock inside existing size cap", () => {
  const value = input();
  const measuredCandidate = {
    ...value.candidate,
    native: [{ id: "glib@0.18.5:registry+https://example.invalid", features: [] }],
  };
  const assessment = assessDispatchedBuild706({
    candidate: measuredCandidate,
    scan: value.scan,
    policy: scannerPolicy,
    now: value.now,
  });
  const raw = { candidate: measuredCandidate, scan: value.scan, assessment };
  const expected = {
    source_commit: value.candidate.head,
    lock_sha256: value.scan.lockSha256,
    started: Date.parse(value.now) - 1000,
    finished: Date.parse(value.now) + 1000,
  };
  assert.deepEqual(inspectCompilerRiskAssessment706(raw, expected), raw);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 128 * 1024);
  assert.throws(
    () => inspectCompilerRiskAssessment706(raw, { ...expected, source_commit: "f".repeat(40) }),
    /producing-job/u,
  );
  assert.throws(
    () => inspectCompilerRiskAssessment706(raw, { ...expected, started: expected.finished }),
    /producing-job/u,
  );
  assert.throws(
    () =>
      inspectCompilerRiskAssessment706(
        { ...raw, assessment: { ...assessment, scanPassed: true } },
        expected,
      ),
    /raw scan/u,
  );
  assert.throws(
    () =>
      inspectCompilerRiskAssessment706(
        { ...raw, candidate: { ...raw.candidate, padding: "x".repeat(128 * 1024) } },
        expected,
      ),
    /bounded/u,
  );
});

void test("exact approved finding produces a separate decision while retaining failed scan status", () => {
  const value = input(),
    before = structuredClone(value);
  const result = decide706(value);
  assert.equal(result.disposition, "accepted-risk");
  assert.equal(result.scanExitCode, 1);
  assert.equal(result.scanPassed, false);
  assert.deepEqual(value, before);
});

void test("absent, expired, premature and out-of-scope approval cannot authorize a release", () => {
  for (const mutate of [
    (x) => {
      // @ts-expect-error Deliberately missing external approval.
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
      // @ts-expect-error Deliberately unallocated publication identity.
      x.approval.firstPublicationTag = null;
    },
  ] satisfies ((value: ReturnType<typeof input>) => void)[]) {
    const value = input();
    mutate(value);
    assert.throws(() => decide706(value));
  }
});

void test("release decisions reject coercible scalar evidence and publication identities", async (t) => {
  await t.test("scan timestamp", () => {
    const value = input();
    assert.throws(() => decide706({ ...value, scan: { ...value.scan, completedAt: [value.now] } }));
  });
  await t.test("approval instant", () => {
    const value = input();
    assert.throws(() => validateApproval706(value.approval, [value.now]));
  });
  await t.test("published release timestamp", () => {
    const value = input();
    assert.throws(() =>
      decide706({
        ...value,
        releases: [
          {
            id: 1,
            draft: false,
            published_at: [value.now],
            tag_name: value.publicationTag,
            assets: [{ name: "Portcove_amd64.AppImage" }],
          },
        ],
      }),
    );
  });
  await t.test("publication tag", () => {
    const value = input();
    const tag = [value.publicationTag];
    assert.throws(() =>
      decide706({
        ...value,
        approval: { ...value.approval, firstPublicationTag: tag },
        publicationTag: tag,
      }),
    );
  });
});

void test("malformed published asset records cannot disappear from the release budget", () => {
  const value = input();
  assert.throws(() =>
    decide706({
      ...value,
      releases: [
        {
          id: 1,
          draft: false,
          published_at: value.now,
          tag_name: value.publicationTag,
          assets: [null],
        },
      ],
    }),
  );
});

void test("source/dependency drift requires reassessment; unrelated source head changes do not", () => {
  for (const field of ["productionChanges", "reviewedHead"] as const) {
    const value = input();
    value.candidate[field] = "e".repeat(64);
    assert.throws(() => decide706(value), /reassessment/);
  }
  const value = input();
  value.candidate.head = "f".repeat(40);
  value.scan.head = value.candidate.head;
  assert.equal(decide706(value).candidate, value.candidate.head);
});

void test("execution failure, wrong candidate, green/incomplete coverage and extra errors block", () => {
  for (const mutate of [
    (x) => {
      x.scan.completedAt = "2000-01-01T00:00:00Z";
    },
    (x) => {
      // @ts-expect-error Deliberately malformed persisted timestamp.
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
  ] satisfies ((value: ReturnType<typeof input>) => void)[]) {
    const value = input();
    mutate(value);
    assert.throws(() => decide706(value));
  }
});

void test("all four scanner checks must complete with consistent summary accounting", () => {
  assert.equal(parseDependencyScan("", output()).errors.length, 1);
  assert.throws(() =>
    parseDependencyScan("", output() + "\n" + JSON.stringify({ type: "summary", fields: summary })),
  );
  assert.throws(() => parseDependencyScan("", output([], summary)), /mismatch/);
});

void test("qualification cannot allocate a publication and the second tag is always refused", () => {
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
  // @ts-expect-error Deliberately unallocated publication identity.
  value.approval.firstPublicationTag = null;
  assert.throws(() => decide706(value), /second ordinary Linux/);
  value.releases = []; // Deleted publication still cannot authorize a different pinned tag.
  value.purpose = "release";
  assert.throws(() => decide706(value), /first publication tag/);
  value.purpose = "qualification";
  assert.throws(() => decide706(value), /purpose/);
  // @ts-expect-error Deliberately missing complete release inventory.
  value.releases = null;
  assert.throws(() => decide706(value), /inventory/);
});

void test("release source review compares the exact candidate against a named reviewed commit", async (t) => {
  const inheritedSha = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = candidate.head;
  t.after(() => {
    if (inheritedSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = inheritedSha;
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-706-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, ".github"));
  writeFileSync(path.join(dir, ".github/linux-beta-risk-706.json"), JSON.stringify(approval));
  writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n");
  const metadata = {
    packages: [
      { id: "desktop", name: "portcove-desktop", version: "0.1.0-alpha.2", source: null },
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
  const execute = (name: string, args: string[]) => {
    if (name === "cargo") return JSON.stringify(metadata);
    if (args[0] === "rev-parse") return candidate.head;
    if (args[0] === "status") return "";
    if (args[0] === "show") return "version = 4\n";
    if (args[0] === "cat-file") return "ordinary source commit\n";
    if (args[0] === "ls-tree") {
      assert.equal(args[1], candidate.head);
      return `100644 blob ${"d".repeat(40)}\tCargo.lock\n`;
    }
    assert.equal(args[2], approval.reconfirmedHead);
    return changes;
  };
  const before = await candidate706(dir, execute);
  process.env.GITHUB_SHA = "f".repeat(40);
  await assert.rejects(() => candidate706(dir, execute), /workflow candidate/);
  process.env.GITHUB_SHA = candidate.head;
  changes = "crates/portcove-core/src/lib.rs";
  const after = await candidate706(dir, execute);
  assert.deepEqual(after.native, before.native);
  assert.equal(after.productionChanges, changes);
  assert.equal(after.reviewedHead, approval.reconfirmedHead);
});
