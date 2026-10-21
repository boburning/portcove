import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { developmentSecurity, recordsDevelopmentPolicy } from "./dependency-security.mts";
import { executeAudit } from "./audit.mts";

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

const policy = readFileSync(new URL("../deny.toml", import.meta.url), "utf8");
const digest = createHash("sha256").update(policy.replaceAll("\r\n", "\n")).digest("hex");
const finding = {
  severity: "error",
  code: "unsound",
  advisory: { id: "RUSTSEC-2024-0429", package: "glib" },
  labels: [{ span: "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index" }],
};
interface FixtureDiagnostic {
  severity: string;
  code: string;
  advisory: { id: string; package: string };
  labels?: { span: string }[];
}
function scan(diagnostics: FixtureDiagnostic[] = [finding]) {
  const summary = {
    advisories: { errors: 0, warnings: 0, notes: 0, helps: 0 },
    bans: { errors: 0, warnings: 0, notes: 0, helps: 0 },
    licenses: { errors: 0, warnings: 0, notes: 0, helps: 0 },
    sources: { errors: 0, warnings: 0, notes: 0, helps: 0 },
  };
  for (const d of diagnostics) {
    assert.ok(d.severity === "error" || d.severity === "warning");
    summary.advisories[d.severity === "error" ? "errors" : "warnings"]++;
  }
  return {
    head: "a".repeat(40),
    complete: true,
    error: null,
    signal: null,
    exitCode: diagnostics.some((d) => d.severity === "error") ? 1 : 0,
    scope: "workspace-default-all-targets-all-checks",
    unsoundAll: true,
    toolVersion: "cargo-deny 0.20.2",
    configSha256: digest,
    sourceConfigSha256: digest,
    sourceConfig: policy,
    executionConfig: policy,
    stdout: "",
    stderr: [
      ...diagnostics.map((fields) => ({ type: "diagnostic", fields })),
      { type: "summary", fields: summary },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  };
}

void test("development policy distinguishes raw failure, clean scan and release authorization", () => {
  const raw = scan();
  const before = structuredClone(raw);
  const result = developmentSecurity(raw, policy);
  assert.equal(result.policyPassed, true);
  assert.equal(result.scanPassed, false);
  assert.equal(result.scanExitCode, 1);
  assert.equal(result.releaseAuthorization, "not-evaluated");
  assert.deepEqual(raw, before);
  assert.equal(developmentSecurity(scan([]), policy).scanPassed, true);
});

void test("actual development CLI succeeds without approval/API and retains raw failed scanner bytes", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-security-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "scripts"));
  writeFileSync(
    path.join(dir, "scripts/dependency-security.mts"),
    readFileSync(new URL("./dependency-security.mts", import.meta.url)),
  );
  writeFileSync(path.join(dir, "deny.toml"), policy);
  writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n");
  const raw = scan();
  const preload = path.join(dir, "scanner-fixture.mjs");
  writeFileSync(
    preload,
    `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    cp.execFileSync = (name,args) => {
      if(name==='git' && args.join(' ')==='rev-parse HEAD') return '${raw.head}';
      if(name==='cargo' && args.join(' ')==='deny --version') return 'cargo-deny 0.20.2';
      throw new Error('Unexpected external command: '+name);
    };
    cp.spawnSync = (name,args) => {
      if(name!=='cargo' || args.at(-2)!=='-W' || args.at(-1)!=='unmaintained') throw new Error('Wrong scanner command');
      return {status:1,signal:null,stdout:'',stderr:${JSON.stringify(raw.stderr)}};
    };
    globalThis.fetch = () => { throw new Error('Release API forbidden'); };
    syncBuiltinESMExports();`,
  );
  writeFileSync(
    path.join(dir, "scripts/runtime-values.mts"),
    readFileSync(new URL("./runtime-values.mts", import.meta.url)),
  );
  writeFileSync(
    path.join(dir, "scripts/release-coordinator-deadline.mts"),
    readFileSync(new URL("./release-coordinator-deadline.mts", import.meta.url)),
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GITHUB_REF_NAME: "no-release-tag",
  };
  delete environment.PORTCOVE_706_SCAN_RECEIPT;
  const run = (args: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        path.join(dir, "scripts/dependency-security.mts"),
        ...args,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        env: environment,
      },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Development security policy: PASS/);
  const evidenceDir = path.join(dir, "work/linux-beta-risk-706");
  const files = readdirSync(evidenceDir);
  const receipt: unknown = JSON.parse(
    readFileSync(
      path.join(
        evidenceDir,
        requiredFixture(files.find((f: string) => !f.endsWith(".decision.json"))),
      ),
      "utf8",
    ),
  );
  assert.ok(isRecord(receipt));
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.stderr, raw.stderr);
  const decision: unknown = JSON.parse(
    readFileSync(
      path.join(
        evidenceDir,
        requiredFixture(files.find((f: string) => f.endsWith(".decision.json"))),
      ),
      "utf8",
    ),
  );
  assert.ok(isRecord(decision));
  assert.equal(decision.scanPassed, false);
  assert.equal(decision.releaseAuthorization, "not-evaluated");
  assert.equal(run(["scan"]).status, 1);
  const originalFixture = readFileSync(preload, "utf8");
  writeFileSync(
    preload,
    originalFixture
      .replace(
        "import cp from 'node:child_process';",
        "import cp from 'node:child_process'; import {writeFileSync} from 'node:fs';",
      )
      .replace(
        "return {status:1,signal:null",
        "writeFileSync('Cargo.lock','changed during scan'); return {status:1,signal:null",
      ),
  );
  const changed = run();
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /source\/lock\/policy\/tool changed/u);
  const after = readdirSync(evidenceDir);
  assert.equal(after.filter((name) => name.endsWith(".decision.json")).length, 1);
  assert.equal(after.filter((name) => !name.endsWith(".decision.json")).length, 3);
});

void test("source/test edits, expired approval and unavailable release API have no development prerequisites", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portcove-dev-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, value] of [
    ["unrelated.rs", "fn production() {}"],
    ["tests.rs", "#[test] fn unrelated() {}"],
    ["approval.json", '{"expiresAt":"2000-01-01"}'],
  ] as const) {
    writeFileSync(path.join(dir, file), value);
    assert.equal(developmentSecurity(scan(), policy).policyPassed, true);
  }
  // The classifier receives neither filesystem/release state nor a network client.
  const source = readFileSync(new URL("./dependency-security.mts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /github-api|from "\.\/linux-beta-risk-706|candidate706|disposition706/,
  );
});

void test("additional errors and changed advisory/package/version/source identity fail closed", () => {
  for (const diagnostics of [
    [finding, { ...finding, advisory: { id: "RUSTSEC-2099-0001", package: "other" } }],
    [{ ...finding, advisory: { ...finding.advisory, id: "GHSA-wrw7-89jp-8q8g" } }],
    [{ ...finding, advisory: { ...finding.advisory, package: "other" } }],
    [
      {
        ...finding,
        labels: [{ span: "glib 0.18.6 registry+https://github.com/rust-lang/crates.io-index" }],
      },
    ],
    [{ ...finding, labels: [{ span: "glib 0.18.5 git+https://example.com/glib" }] }],
  ])
    assert.throws(() => developmentSecurity(scan(diagnostics), policy), /blocking finding/);
});

void test("incomplete, malformed, timed out, wrong tool/config and inconsistent scanner executions fail", () => {
  for (const mutation of [
    { complete: false },
    { error: "ETIMEDOUT" },
    { signal: "SIGTERM" },
    { exitCode: null },
    { exitCode: 2 },
    { exitCode: 0 },
    { stderr: "{}" },
    { stderr: "truncated" },
    { stdout: "corrupted" },
    { unsoundAll: false },
    { toolVersion: "cargo-deny unknown" },
    { configSha256: "0".repeat(64) },
    { executionConfig: policy + "\n# changed" },
    { scope: "advisories-only" },
  ])
    assert.throws(() => developmentSecurity({ ...scan(), ...mutation }, policy));
});

void test("configured warning severity remains nonblocking without accepting new errors", () => {
  const warning = {
    severity: "warning",
    code: "unmaintained",
    advisory: { id: "RUSTSEC-2024-0370", package: "proc-macro-error" },
  };
  assert.equal(developmentSecurity(scan([finding, warning]), policy).policyPassed, true);
  assert.equal(developmentSecurity(scan([warning]), policy).scanPassed, true);
  assert.throws(() =>
    developmentSecurity(scan([finding, { ...warning, severity: "error" }]), policy),
  );
});

void test("policy success cannot cover independent audit failure or become scanner evidence", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-dev-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stages = ["dependency-policy", "other-quality"].map((id) => ({
    id,
    recipe: id,
    fingerprint: id,
    action: "run" as const,
    reusable: false,
  }));
  const result = executeAudit(
    { head: "a".repeat(40), receiptRoot: root, stages },
    { execute: () => ({ status: 1 }) },
  );
  const decision = developmentSecurity(scan(), policy);
  const head = result.report.head;
  assert.equal(typeof head, "string");
  assert.equal(result.success, false);
  assert.equal(
    recordsDevelopmentPolicy({ ...result.report, policyDecision: decision }, head),
    false,
  );
  const onlyKnown = structuredClone(result.report);
  requiredFixture(onlyKnown.stages[1]).status = "passed";
  const withDecision = { ...onlyKnown, policyDecision: decision };
  assert.equal(recordsDevelopmentPolicy(withDecision, head), true);
  assert.equal(onlyKnown.success, false);
  assert.equal(requiredFixture(onlyKnown.stages[0]).status, "failed");
});
