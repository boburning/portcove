import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { errorCode } from "./runtime-values.mts";
import type { ValidationChangeInput, ValidationPlan, ValidationGroup } from "./validation-plan.mts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidationPlan,
  encodeValidationPlanEnvironment,
  readValidationPlanInput,
  digestValidationPlan,
  fastGroups,
  qualificationPlatforms,
  validateValidationPlan,
  validateQualificationBinding,
  validationOwnershipForPath,
} from "./validation-plan.mts";
import { discoverCiPlan } from "./select-ci-plan.mts";
const sha = (c: string) => c.repeat(40);
const change = (file: string, values: Partial<ValidationChangeInput> = {}) => ({
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  oldPath: file,
  newPath: file,
  ...values,
});
const plan = (
  changes: ValidationChangeInput[],
  values: Partial<Parameters<typeof buildValidationPlan>[0]> = {},
) =>
  buildValidationPlan({
    changes,
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
    ...values,
  });
const redigest = <Plan extends object>(p: Plan) => ({ ...p, digest: digestValidationPlan(p) });

void test("qualification profile is digest-bound and cannot satisfy a different expected profile", () => {
  const beta = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: sha("d"),
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-win-linux",
  });
  assert.equal(
    validateQualificationBinding({
      plan: beta,
      digest: beta.digest,
      checkout: sha("d"),
      releaseProfile: "initial-beta-win-linux",
    }),
    beta,
  );
  assert.throws(
    () => validateQualificationBinding({ plan: beta, digest: beta.digest, checkout: sha("d") }),
    /profile mismatch/,
  );
  const full = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("d"),
    forceQualification: true,
  });
  assert.throws(
    () =>
      validateQualificationBinding({
        plan: full,
        digest: full.digest,
        checkout: sha("d"),
        releaseProfile: "initial-beta-win-linux",
      }),
    /profile mismatch/,
  );
  assert.throws(
    () =>
      validateQualificationBinding({
        plan: full,
        digest: full.digest,
        checkout: sha("d"),
        releaseProfile: "foreign",
      }),
    /unknown/,
  );
  assert.throws(
    () => validateValidationPlan({ ...beta, release_profile: undefined }),
    /profile|digest/,
  );
  for (const mutation of [
    { release_profile: "foreign" },
    { release_profile: "full" },
    { mode: "fast", qualification_required: false },
    { reason: "schedule" },
    { groups: beta.groups.filter((group) => group !== "catalog") },
    { platforms: qualificationPlatforms },
    { release_profile: undefined },
  ])
    assert.throws(() => validateValidationPlan(redigest({ ...beta, ...mutation })));
});

void test("regular executable modes route by ownership while nonregular inputs block", () => {
  for (const modes of [
    { oldMode: "100755", newMode: "100755" },
    { status: "A", oldMode: "000000", newMode: "100755" },
    { status: "D", oldMode: "100755", newMode: "000000" },
    { oldMode: "100644", newMode: "100755" },
    { oldMode: "100755", newMode: "100644" },
  ]) {
    const selected = plan([change("scripts/bootstrap-quality-tools.sh", modes)]);
    assert.equal(selected.mode, "fast");
    assert.deepEqual(selected.platforms, ["primary-host"]);
    validateValidationPlan(selected);
  }
  for (const mode of ["120000", "160000"]) {
    const blocked = plan([change("scripts/input", { oldMode: mode, newMode: mode })]);
    assert.equal(blocked.mode, "blocked");
    validateValidationPlan(blocked);
  }
});

void test("shared browser trace runtime selects required frontend coverage", () => {
  const file = "scripts/browser-traces.ts";
  const ownership = validationOwnershipForPath(file);
  assert.ok(ownership.groups.includes("frontend"));
  assert.ok(plan([change(file)]).groups.includes("frontend"));
});

void test("shared frontend compiler policy selects the same required checks as the root compiler config", () => {
  const shared = validationOwnershipForPath("tsconfig.base.json");
  const root = validationOwnershipForPath("tsconfig.json");
  assert.deepEqual({ ...shared, path: root.path }, root);
});

void test("scoped beta matcher and Roadmap release consumer retain protected qualification ownership", () => {
  for (const file of [
    "scripts/linux-beta-risk-706.mts",
    "scripts/linux-beta-risk-706.test.mts",
    "scripts/roadmap.mts",
    "scripts/roadmap.test.mts",
  ]) {
    const ownership = validationOwnershipForPath(file);
    assert.equal(ownership.qualificationRequired, true);
    assert.ok(ownership.areas.includes("policy"));
    assert.ok(ownership.areas.includes("release-security"));
    assert.deepEqual(ownership.platforms, qualificationPlatforms);
  }
});

void test("coordinator state and remote transport retain protected release qualification ownership", () => {
  for (const file of [
    "scripts/release-coordinator-state.mts",
    "scripts/release-coordinator-remote.mts",
    "scripts/release-coordinator-recovery.mts",
    "scripts/recover-local-worker-empty-setup.ps1",
    "scripts/resume-local-worker-profile.ps1",
    "scripts/recover-local-worker-empty-setup.test.mts",
    "scripts/release-source-changes.mts",
    "scripts/trusted-release-assembly.mts",
    "scripts/release-artifact-archive.mts",
    "scripts/release-artifact-assembly.mts",
    "scripts/bounded-zip.mts",
    "scripts/github-binary.mts",
    "scripts/assembler-job-identity.mts",
    "scripts/trusted-aggregate-attestation.mts",
    "scripts/production-aggregate-steps.mts",
    "scripts/acquire-release-admission.mts",
    "scripts/release-coordinator-errors.mts",
    "docs/qualification/application-update-production.aggregate.yml",
    "docs/qualification/slice4-production-authorization-packet-2026-10-18.md",
  ]) {
    const ownership = validationOwnershipForPath(file);
    assert.equal(ownership.qualificationRequired, true);
    assert.ok(ownership.areas.includes("release-security"));
    assert.deepEqual(ownership.platforms, qualificationPlatforms);
  }
});

void test("ordinary layers select the minimum baseline and union mixed changes", () => {
  for (const [file, groups] of [
    ["apps/desktop/src/App.tsx", ["frontend", "rust-quality"]],
    ["crates/portcove-core/src/lib.rs", ["rust", "rust-quality"]],
    ["Cargo.lock", ["dependency-review", "rust", "rust-quality"]],
    ["apps/desktop/package.json", ["dependency-review", "frontend", "rust-quality"]],
    ["docs/QUALITY.md", ["catalog", "rust-quality"]],
    [".github/workflows/ci.yml", ["catalog", "rust-quality"]],
    ["scripts/validation-plan.mts", ["catalog", "rust-quality"]],
  ] as const) {
    const p = plan([change(file)]);
    assert.equal(p.mode, "fast");
    assert.deepEqual(p.groups, groups);
    assert.deepEqual(p.platforms, ["primary-host"]);
    validateValidationPlan(p);
  }
  assert.deepEqual(plan([change("Cargo.lock"), change("apps/desktop/src/App.tsx")]).groups, [
    "dependency-review",
    "frontend",
    "rust",
    "rust-quality",
  ]);
});
void test("docs and captures ignore schema/catalog/platform topic words", () => {
  for (const file of [
    "docs/SIGNED-CATALOG.md",
    "docs/UPDATER-TRUST.md",
    "docs/media/windows-ipc-catalog.png",
    "AGENTS.md",
    ".agents/skills/portcove-release-validation/SKILL.md",
  ])
    assert.deepEqual(plan([change(file)]).groups, ["catalog", "rust-quality"]);
  assert.equal(plan([change("docs/README.md")]).mode, "prose");
});
void test("shared toolchain and safe unknown inputs select the entire Windows baseline", () => {
  for (const file of [".node-version", ".github/quality-tools.json", "future/new-script.xyz"]) {
    const p = plan([change(file)]);
    assert.deepEqual(p.groups, fastGroups);
    assert.equal(p.mode, "fast");
    validateValidationPlan(p);
  }
  const p = plan([change("future/new-script.xyz")]);
  assert.deepEqual(p.fallback, { kind: "all-fast-groups", paths: ["future/new-script.xyz"] });
});
void test("native/platform and release implementation edits stay ordinary; full coverage is explicit", () => {
  for (const file of [
    "apps/desktop/src-tauri/src/application_update_windows.rs",
    "scripts/test-linux-package-ownership.sh",
    "scripts/sign-catalog.mts",
  ]) {
    const p = plan([change(file)]);
    assert.equal(p.mode, "fast");
    assert.equal(p.qualification_required, false);
    assert.deepEqual(p.platforms, ["primary-host"]);
    validateValidationPlan(p);
  }
  const p = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("d"),
    forceQualification: true,
  });
  assert.equal(p.mode, "qualification");
  assert.deepEqual(p.groups, fastGroups);
  assert.deepEqual(p.platforms, qualificationPlatforms);
  validateQualificationBinding({ plan: p, digest: p.digest, checkout: sha("d") });
  assert.throws(() =>
    validateQualificationBinding({ plan: p, digest: p.digest, checkout: sha("c") }),
  );
});
void test("both rename sides and deletions preserve explicit change identity", () => {
  const changes = [
    change("crates/portcove-core/src/source_report.rs", {
      status: "R",
      newPath: "docs/old-rust.md",
    }),
    change("apps/desktop/src/old.tsx", { status: "D", newMode: "000000" }),
  ];
  const p = plan(changes);
  assert.equal(p.changes.length, 2);
  assert.ok(p.groups.includes("rust"));
  assert.ok(p.groups.includes("frontend"));
  assert.ok(p.changed_files.includes("docs/old-rust.md"));
  validateValidationPlan(p);
});
void test("incomplete discovery and unsafe modes/statuses block; unsafe paths reject", () => {
  for (const input of [
    plan([]),
    plan([change("AGENTS.md", { newMode: "120000" })]),
    plan([change("x", { status: "C" })]),
    plan([], { discovery: "failed", blockedReason: "missing-base" }),
  ]) {
    assert.equal(input.mode, "blocked");
    assert.deepEqual(input.groups, []);
    validateValidationPlan(input);
  }
  for (const file of ["../secret", "/absolute", "bad\\path", "bad\0path"])
    assert.throws(() => plan([change(file)]));
});
void test("digest and structural tampering cannot authorize missing or stale lanes", () => {
  const p = plan([change("crates/portcove-core/src/lib.rs")]);
  assert.throws(() => validateValidationPlan({ ...p, groups: [] }));
  type MutableGroupPlan = Omit<ValidationPlan, "groups"> & { groups: ValidationGroup[] };
  for (const mutate of [
    (q) => q.groups.pop(),
    (q) => (q.changes = []),
    (q) => (q.identities.head = "short"),
    (q) => (q.paths = []),
    (q) => (q.discovery = "failed"),
    (q) => (q.platforms = []),
  ] satisfies readonly ((candidate: MutableGroupPlan) => unknown)[]) {
    const q = { ...structuredClone(p), groups: [...p.groups] };
    mutate(q);
    assert.throws(() => validateValidationPlan(redigest(q)));
  }
  const q = plan([change("unknown.bin")]);
  q.fallback = null;
  assert.throws(() => validateValidationPlan(redigest(q)));
});

void test("generated transport snapshots and declaration inputs retain real Rust drift validation", () => {
  for (const file of [
    "apps/desktop/src/transport-host-output.generated.json",
    "apps/desktop/src/transport-types.generated.d.ts",
    "scripts/check-transport-contract.mts",
    "apps/desktop/scripts/generate-transport-types.mts",
  ]) {
    const selected = plan([change(file)]);
    validateValidationPlan(selected);
    assert.ok(selected.groups.includes("rust"), file);
    assert.ok(selected.groups.includes("frontend"), file);
    assert.ok(selected.groups.includes("catalog"), file);
  }
});

void test("actual Stylelint loader and typed policy retain protected audit qualification", () => {
  for (const file of [
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/scripts/stylelint-config.mts",
  ]) {
    const ownership = validationOwnershipForPath(file);
    assert.ok(ownership.areas.includes("policy"), file);
    assert.equal(ownership.qualificationRequired, true, file);
    assert.deepEqual(
      ownership.platforms,
      [...qualificationPlatforms].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      file,
    );
  }
});

void test("validation plan rejects malformed retained equivalence proof before trusting its lanes", () => {
  const proof = {
    parser: "python-tomllib-v1",
    before: "a".repeat(64),
    after: "b".repeat(64),
  } as const;
  const candidate = plan([change(".config/nextest.toml", { nextest_equivalence: proof })]);
  assert.equal(validateValidationPlan(candidate), candidate);
  const entry = candidate.changes[0];
  assert(entry);
  for (const malformed of [null, {}, { ...proof, before: {} }, { ...proof, parser: "other" }]) {
    const tampered = redigest({
      ...candidate,
      changes: [{ ...entry, nextest_equivalence: malformed }],
    });
    assert.throws(() => validateValidationPlan(tampered), /nextest equivalence proof/u);
  }
});

void test("large plans cross native process environments without losing paths, digest or checking authority", () => {
  const expected = plan(
    Array.from({ length: 500 }, (_, index) =>
      change(`apps/desktop/src/migration-${index.toString().padStart(4, "0")}-contract.tsx`),
    ),
  );
  const raw = JSON.stringify(expected);
  assert.ok(Buffer.byteLength(raw) > 128 * 1024, "exercise the hosted single-string exec limit");
  const encoded = encodeValidationPlanEnvironment(expected);
  assert.ok(encoded.length < 64 * 1024);
  const script = `import { readValidationPlanInput, validateValidationPlan } from ${JSON.stringify(new URL("./validation-plan.mts", import.meta.url).href)}; console.log(JSON.stringify(validateValidationPlan(readValidationPlanInput())));`;
  const environment = {
    ...process.env,
    PORTCOVE_PLAN_JSON: undefined,
    PORTCOVE_PLAN_GZIP_BASE64: encoded,
  };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const received = validateValidationPlan(JSON.parse(result.stdout));
  assert.deepEqual(received, expected);
  assert.deepEqual(
    validateValidationPlan(readValidationPlanInput({ PORTCOVE_PLAN_JSON: raw })),
    expected,
  );
  if (process.platform === "linux") {
    const rejected = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...environment, PORTCOVE_PLAN_GZIP_BASE64: undefined, PORTCOVE_PLAN_JSON: raw },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(
      errorCode(rejected.error),
      "E2BIG",
      "the same raw plan reproduces the hosted failure",
    );
  }
});

void test("plan environment transport rejects ambiguity, corrupt encoding and bounded inflation before validation", () => {
  const expected = plan([change("apps/desktop/src/App.tsx")]);
  const encoded = encodeValidationPlanEnvironment(expected);
  assert.throws(
    () =>
      readValidationPlanInput({
        PORTCOVE_PLAN_JSON: JSON.stringify(expected),
        PORTCOVE_PLAN_GZIP_BASE64: encoded,
      }),
    /ambiguous/,
  );
  for (const value of ["", "?", "AAAA", "AA=A", "A".repeat(64 * 1024 + 4)])
    assert.throws(() => readValidationPlanInput({ PORTCOVE_PLAN_GZIP_BASE64: value }));
  for (const bytes of [Buffer.from([0xff]), Buffer.from("{invalid")])
    assert.throws(() =>
      readValidationPlanInput({ PORTCOVE_PLAN_GZIP_BASE64: gzipSync(bytes).toString("base64") }),
    );
  const limit = 1024 * 1024;
  const exact = { padding: "x".repeat(limit - Buffer.byteLength(JSON.stringify({ padding: "" }))) };
  const exactJson = JSON.stringify(exact);
  assert.equal(Buffer.byteLength(exactJson), limit);
  assert.deepEqual(
    readValidationPlanInput({ PORTCOVE_PLAN_GZIP_BASE64: gzipSync(exactJson).toString("base64") }),
    exact,
  );
  const oversized = JSON.stringify({ padding: exact.padding + "x" });
  assert.equal(Buffer.byteLength(oversized), limit + 1);
  assert.throws(
    () =>
      readValidationPlanInput({
        PORTCOVE_PLAN_GZIP_BASE64: gzipSync(oversized).toString("base64"),
      }),
    { code: "ERR_BUFFER_TOO_LARGE" },
  );
  const tampered = { ...expected, groups: [] };
  const input = readValidationPlanInput({
    PORTCOVE_PLAN_GZIP_BASE64: gzipSync(JSON.stringify(tampered)).toString("base64"),
  });
  assert.throws(() => validateValidationPlan(input), /digest|group/);
  assert.throws(
    () => readValidationPlanInput({ PORTCOVE_PLAN_JSON: " ".repeat(1024 * 1024 + 1) }),
    /byte limit/,
  );
});
