import { isRecord } from "./runtime-values.mts";
import type { TestContext } from "node:test";
import type { SpawnSyncOptions } from "node:child_process";
import type {
  HostedCommand,
  HostedSpawnResult,
  HostedExecutionOptions,
  ProvenanceBuildOptions,
  CargoDependencySpecification,
} from "./workflow-provenance.mts";
import { deflateRawSync } from "node:zlib";
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function lookup(values: Record<string, string>, key: string): string {
  return required(values[key]);
}
type CargoMutationFixture = Omit<
  CargoDependencySpecification,
  "package" | "from_version" | "to_version" | "from_checksum" | "to_checksum" | "lock_sha256"
> & {
  package: unknown;
  from_version: unknown;
  to_version: unknown;
  from_checksum: unknown;
  to_checksum: unknown;
  lock_sha256: unknown;
  extra?: unknown;
};
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { recoverBackupEvidence } from "./native-backup-evidence.mts";

import {
  buildWorkflowProvenance,
  parseProvenanceArchive,
  validateWorkflowProvenance,
  hostedLocalCheckAuthorityPaths,
  isHostedLocalCheckScriptAuthority,
  hostedLocalCheckEnvironment,
  runHostedLocalCheck,
  parseHostedValidationBinding,
  assertRetainedSelectedPlan,
  runHostedValidation,
} from "./workflow-provenance.mts";

void test("slice3 Windows recovery binds fixed sources and scenarios without billed evidence storage", () => {
  const nativeDesignCompatibilityWorkflow = readFileSync(
    new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
    "utf8",
  );
  const workflow: unknown = parseYaml(nativeDesignCompatibilityWorkflow);
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs));
  const job = workflow.jobs.slice3_windows_recovery;
  assert.ok(isRecord(job));
  assert.equal(job["runs-on"], "windows-2022");
  assert.equal(job["timeout-minutes"], 90);
  assert.match(String(job.if), /inputs.operation == 'slice3-windows-recovery'/);
  assert.match(String(job.if), /inputs.runner == 'windows-2022'/);
  assert.match(String(job.if), /github.event.repository.visibility == 'public'/);
  assert.ok(isRecord(job.strategy) && isRecord(job.strategy.matrix));
  assert.equal(job.strategy["fail-fast"], false);
  assert.ok(Array.isArray(job.strategy.matrix.include));
  assert.deepEqual(
    job.strategy.matrix.include.map((entry: unknown) => {
      assert.ok(isRecord(entry));
      return { source: entry.source, scenario: entry.scenario };
    }),
    [
      {
        source: "46169b5be87e149b15e31a745b2d7ebdf1e98004",
        scenario: "native-host-publication-recovery",
      },
    ],
  );
  assert.ok(Array.isArray(job.steps));
  const checkout: unknown = job.steps.find(
    (step: unknown) => isRecord(step) && String(step.uses).startsWith("actions/checkout@"),
  );
  assert.ok(isRecord(checkout) && isRecord(checkout.with));
  assert.equal(checkout.with.ref, "${{ matrix.source }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const block = nativeDesignCompatibilityWorkflow
    .split("\n  slice3_windows_recovery:")[1]
    ?.split("\n  hosted_selected:")[0];
  assert.ok(block);
  assert.match(block, /user_interactive -or \$identity.session_id -le 0/);
  assert.match(block, /bootstrap-quality-tools.ps1 -Profile native-desktop/);
  assert.match(block, /Application target must be fresh/);
  assert.match(block, /qualification_checkpoint::tests/);
  assert.match(block, /--scenario \$env:SCENARIO --require-clean/);
  assert.match(block, /native-backup-evidence.mts emit/);
  assert.doesNotMatch(
    block,
    /upload-artifact|rust-cache|actions\/cache|cache: pnpm|inputs\.execution_binding/,
  );
});

void test(
  "Windows recovery exposes selected Cargo executables before bootstrap and in later steps",
  { skip: process.platform !== "win32" },
  (t) => {
    const workflow: unknown = parseYaml(
      readFileSync(
        new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
        "utf8",
      ),
    );
    const job = record(record(record(workflow).jobs).slice3_windows_recovery);
    assert.ok(Array.isArray(job.steps));
    const steps: unknown[] = job.steps;
    const provisioning = record(
      required(
        steps.find(
          (step) =>
            record(step).name === "Provision source-pinned packages and native prerequisites",
        ),
      ),
    );
    const program = text(provisioning.run);
    const prefix = required(program.split("pnpm install --frozen-lockfile")[0]);
    assert.match(prefix, /tool-cache.mts --paths/);
    assert.match(prefix, /development-capabilities.mts --profile native-desktop/);
    assert.match(prefix, /\$cargoBins \| Add-Content -LiteralPath \$env:GITHUB_PATH/);
    const temporary = mkdtempSync(path.join(tmpdir(), "portcove-windows-tool-path-"));
    const relative = path.relative(tmpdir(), temporary);
    assert.ok(relative.startsWith("portcove-windows-tool-path-") && !relative.includes(".."));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["LOCALAPPDATA", "GITHUB_PATH"].includes(name.toUpperCase()),
      ),
    );
    environment.LOCALAPPDATA = path.join(temporary, "cache");
    environment.GITHUB_PATH = path.join(temporary, "github-path");
    writeFileSync(environment.GITHUB_PATH, "");
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const paths = record(
      JSON.parse(
        execFileSync(process.execPath, ["scripts/tool-cache.mts", "--paths"], {
          cwd,
          env: environment,
          encoding: "utf8",
        }),
      ),
    );
    const plan = record(
      JSON.parse(
        execFileSync(
          process.execPath,
          ["scripts/development-capabilities.mts", "--profile", "native-desktop"],
          { cwd, env: environment, encoding: "utf8" },
        ),
      ),
    );
    const selected = record(plan.setup).cargo_tools;
    assert.ok(Array.isArray(selected) && selected.length > 0);
    const expected = selected.map((value: unknown) => {
      const tool = record(value);
      return path.join(text(paths.cargoRoot), text(tool.crate), text(tool.version), "bin");
    });
    const observed: unknown = JSON.parse(
      execFileSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          prefix + "\n[ordered]@{ path = $env:PATH } | ConvertTo-Json -Compress",
        ],
        { cwd, env: environment, encoding: "utf8", timeout: 30_000 },
      ),
    );
    assert.equal(
      text(record(observed).path)
        .split(path.delimiter)
        .slice(0, expected.length)
        .join(path.delimiter),
      expected.join(path.delimiter),
    );
    assert.deepEqual(
      readFileSync(environment.GITHUB_PATH, "utf8").trim().split(/\r?\n/u),
      expected,
    );
  },
);

const reviewedPlan = [
  { id: "diff-check", executable: "git", args: ["diff", "--check"], cwd: "$SOURCE/" },
];
function defaultReviewedBinding() {
  return {
    format_version: 1,
    operation: "bootstrap",
    source: "a".repeat(40),
    controller: "a".repeat(40),
    base: "b".repeat(40),
    merge_base: "b".repeat(40),
    authority: "b".repeat(40),
    inventory_sha256: "c".repeat(64),
    plan_digest: "d".repeat(64),
    baseline_plan: reviewedPlan,
    selected_plan: reviewedPlan,
  };
}
function reviewedBinding(): ReturnType<typeof defaultReviewedBinding>;
function reviewedBinding<T extends object>(
  overrides: T,
): Omit<ReturnType<typeof defaultReviewedBinding>, keyof T> & T;
function reviewedBinding(overrides: object = {}) {
  return Object.assign(defaultReviewedBinding(), overrides);
}
const bindingDigest = (raw: string) => createHash("sha256").update(raw).digest("hex");

void test("reviewed hosted bindings retain baseline obligations and reject caller command extensions", () => {
  const raw = JSON.stringify(reviewedBinding());
  assert.equal(parseHostedValidationBinding(raw, bindingDigest(raw)).operation, "bootstrap");
  assert.throws(() => parseHostedValidationBinding(raw, "0".repeat(64)), /digest/);
  for (const patch of [
    { command: "arbitrary shell" },
    { source: "not-a-sha" },
    { controller: "e".repeat(40) },
    { operation: "shell" },
    { selected_plan: [] },
  ]) {
    const invalid = JSON.stringify(reviewedBinding(patch));
    assert.throws(() => parseHostedValidationBinding(invalid, bindingDigest(invalid)));
  }
  assert.throws(
    () => assertRetainedSelectedPlan(reviewedPlan, [{ ...reviewedPlan[0], args: ["diff"] }]),
    /arguments removed/,
  );
  assert.throws(
    () => assertRetainedSelectedPlan(reviewedPlan, [{ ...reviewedPlan[0], cwd: "another-root" }]),
    /Missing baseline/,
  );
  assert.throws(
    () => assertRetainedSelectedPlan(reviewedPlan, [reviewedPlan[0], reviewedPlan[0]]),
    /inventory/,
  );
});

void test("bootstrap binds actual clean Git inventories and refuses out-of-scope or dirty inputs", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-reviewed-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const controller = path.join(directory, "controller");
  const git = (cwd: string, args: readonly string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  };
  mkdirSync(source);
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.name", "Reviewed fixture"]);
  git(source, ["config", "user.email", "fixture@invalid"]);
  write("rust-toolchain.toml", 'channel = "1.98.1"\n');
  write("scripts/audit.mts", "preserved audit\n");
  write(".node-version", process.versions.node + "\n");
  write("package.json", JSON.stringify({ packageManager: "pnpm@12.8.1" }));
  write(
    ".github/quality-tools.json",
    JSON.stringify({ tools: [{ id: "just", version: "1.58.0" }] }),
  );
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "trusted base"]);
  const base = git(source, ["rev-parse", "HEAD"]);
  for (const name of [
    ".github/workflows/ci.yml",
    ".github/workflows/native-design-compatibility.yml",
    "scripts/workflow-provenance.mts",
    "scripts/native-backup-evidence.mts",
  ])
    write(name, "reviewed transport bytes\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "reviewed bootstrap"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  git(directory, ["clone", "--quiet", source, controller]);
  const names = git(source, ["diff", "--name-only", "--no-renames", base, head]).split("\n");
  const inventory = names.map((name) => ({
    path: name,
    base: git(source, ["ls-tree", base, "--", name]),
    source: git(source, ["ls-tree", head, "--", name]),
  }));
  const spec = reviewedBinding({
    source: head,
    controller: head,
    base,
    authority: base,
    merge_base: base,
    inventory_sha256: bindingDigest(JSON.stringify(inventory)),
  });
  const raw = JSON.stringify(spec);
  const environment = {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_SHA: head,
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/native-design-compatibility.yml@refs/heads/fixture",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "hosted_selected",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    PORTCOVE_LOCAL_OPERATION: "bootstrap",
    PORTCOVE_LOCAL_BINDING: raw,
    PORTCOVE_LOCAL_BINDING_SHA256: bindingDigest(raw),
  };
  const options: HostedExecutionOptions = {
    controllerRoot: controller,
    environment,
    command: (name: string, args: readonly string[], cwd: string) => {
      assert.equal(name, "git", "Prepare must not provision or execute candidate tools");
      return git(cwd, args);
    },
  };
  assert.equal(await runHostedValidation("controller", options), 0);
  assert.equal(await runHostedValidation("prepare", options), 0);
  await t.test("failed preflight retains its report before refusing provisioning", async () => {
    const plan = [
      { id: "ui-build", executable: "corepack", args: ["pnpm", "run", "build"], cwd: "$SOURCE/" },
    ];
    const bound = { ...spec, baseline_plan: plan, selected_plan: plan };
    const boundRaw = JSON.stringify(bound);
    const matching = {
      source: head,
      base,
      merge_base: base,
      plan_digest: bound.plan_digest,
      selected_plan: plan,
      obligations: [{ id: "ui-build", missing: [] }],
      pre_change_audit: { missing_local_prerequisites: ["complete-audit-prerequisites"] },
    };
    const evidence = path.join(directory, "hosted-evidence");
    for (const report of [
      { ...matching, obligations: [{ id: "ui-build", missing: ["pnpm"] }] },
      { ...matching, selected_plan: [{ ...plan[0], args: ["pnpm", "run", "other"] }] },
      { ...matching, obligations: [{ id: "ui-build", missing: "" }] },
      matching,
    ]) {
      const commands: { name: string; args: readonly string[]; cwd: SpawnSyncOptions["cwd"] }[] =
        [];
      const result = runHostedValidation("provision", {
        ...options,
        environment: {
          ...environment,
          PORTCOVE_LOCAL_BINDING: boundRaw,
          PORTCOVE_LOCAL_BINDING_SHA256: bindingDigest(boundRaw),
        },
        command: (name: string, args: readonly string[], cwd: string) => {
          if (name === "git") return git(cwd, args);
          assert.equal(cwd, source);
          return lookup(
            {
              just: "just 1.58.0",
              pnpm: "12.8.1",
              rustc: "rustc 1.98.1 (fixture)",
              cargo: "cargo 1.98.1 (fixture)",
            },
            name,
          );
        },
        spawn: (name, args, settings) => {
          commands.push({ name, args, cwd: settings.cwd });
          assert.equal(name, process.execPath);
          assert.deepEqual(args, [
            "scripts/local-validation.mts",
            "check",
            "--preflight",
            "--json",
          ]);
          assert.equal(settings.cwd, source);
          return { status: 1, stdout: JSON.stringify(report) };
        },
      });
      if (report === matching) assert.equal(await result, 0);
      else if (report.obligations.some((entry) => typeof entry.missing === "string"))
        await assert.rejects(() => result, /prerequisite list is not an array/);
      else
        await assert.rejects(() => result, /Full reviewed selected plan or prerequisites differ/);
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(evidence, "selected-plan.json"), "utf8")),
        report,
      );
      assert.equal(commands.length, 1, "No browser or selected command may run during refusal");
      assert.throws(() => readFileSync(path.join(evidence, "execution.json")), /ENOENT/);
    }
    const command: HostedCommand = (name, args, cwd) =>
      name === "git"
        ? git(cwd, args)
        : lookup(
            {
              just: "just 1.58.0",
              pnpm: "12.8.1",
              rustc: "rustc 1.98.1 (fixture)",
              cargo: "cargo 1.98.1 (fixture)",
            },
            name,
          );
    for (const [reason, response] of [
      ["json", { status: 0, stdout: "private invalid JSON" }],
      ["report-evaluation", { status: 0, stdout: "null" }],
      [
        "child-error",
        { status: null, error: Object.assign(Error("private timeout"), { code: "ETIMEDOUT" }) },
      ],
      ["child-status", { status: 7, stdout: "{}" }],
    ] satisfies [string, HostedSpawnResult][]) {
      const logs: string[] = [];
      let calls = 0;
      await assert.rejects(
        runHostedValidation("provision", {
          ...options,
          command,
          log: (line: string) => logs.push(line),
          spawn: (_name, _args, settings) => {
            calls++;
            assert.equal(settings.timeout, 60_000);
            assert.equal(settings.maxBuffer, 16 * 1024 * 1024);
            return response;
          },
        }),
      );
      assert.equal(calls, 1);
      assert.ok(logs.some((line) => line.includes(`"reason":"${reason}"`)));
      assert.ok(logs.every((line) => !line.includes("private")));
    }
  });
  await assert.rejects(() => runHostedValidation("audit", options), /phase\/job/);
  await assert.rejects(() => runHostedValidation("compiled", options), /Phase differs/);
  await assert.rejects(
    () =>
      runHostedValidation("prepare", {
        ...options,
        environment: { ...environment, GITHUB_SHA: base },
      }),
    /identity differs/,
  );
  write("unowned.mjs", "outside scope\n");
  await assert.rejects(() => runHostedValidation("prepare", options), /dirty/);
  rmSync(path.join(source, "unowned.mjs"));
  const wrong = JSON.stringify({ ...spec, inventory_sha256: "0".repeat(64) });
  await assert.rejects(
    () =>
      runHostedValidation("prepare", {
        ...options,
        environment: {
          ...environment,
          PORTCOVE_LOCAL_BINDING: wrong,
          PORTCOVE_LOCAL_BINDING_SHA256: bindingDigest(wrong),
        },
      }),
    /inventory differs/,
  );
  for (const [label, file] of [
    ["extracted-authority", "scripts/validation-evidence.mts"],
    ["standalone-reporter", "scripts/standalone-rust-tests.mts"],
    ["binary-identity", "scripts/development-evidence.mts"],
    ["skip-route-contract", "scripts/nextest-skip-routes.mts"],
  ])
    await t.test("bootstrap preserves " + label, async () => {
      const originalBranch = git(source, ["branch", "--show-current"]);
      git(source, ["checkout", "--quiet", "-b", label + "-control"]);
      write(file!, "changed receipt authority\n");
      git(source, ["add", "."]);
      git(source, ["commit", "--quiet", "-m", "changed extracted audit authority"]);
      const altered = git(source, ["rev-parse", "HEAD"]);
      git(controller, ["fetch", "--quiet", "origin"]);
      git(controller, ["checkout", "--quiet", "--detach", altered]);
      const alteredInventory = git(source, ["diff", "--name-only", "--no-renames", base, altered])
        .split("\n")
        .map((name) => ({
          path: name,
          base: git(source, ["ls-tree", base, "--", name]),
          source: git(source, ["ls-tree", altered, "--", name]),
        }));
      const alteredRaw = JSON.stringify({
        ...spec,
        source: altered,
        controller: altered,
        inventory_sha256: bindingDigest(JSON.stringify(alteredInventory)),
      });
      await assert.rejects(
        () =>
          runHostedValidation("prepare", {
            ...options,
            environment: {
              ...environment,
              GITHUB_SHA: altered,
              GITHUB_WORKFLOW_SHA: altered,
              PORTCOVE_LOCAL_BINDING: alteredRaw,
              PORTCOVE_LOCAL_BINDING_SHA256: bindingDigest(alteredRaw),
            },
          }),
        file === "scripts/validation-evidence.mts"
          ? /preserved recipes, pins, resources or containment/
          : /independently admitted fifteen-path scope/,
      );
      git(source, ["checkout", "--quiet", originalBranch]);
      git(controller, ["checkout", "--quiet", "--detach", head]);
    });
  write(".github/workflows/unadmitted.yml", "outside scope\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "unadmitted workflow"]);
  const outside = git(source, ["rev-parse", "HEAD"]);
  git(controller, ["fetch", "--quiet", "origin"]);
  git(controller, ["checkout", "--quiet", "--detach", outside]);
  const outsideInventory = git(source, ["diff", "--name-only", "--no-renames", base, outside])
    .split("\n")
    .map((name) => ({
      path: name,
      base: git(source, ["ls-tree", base, "--", name]),
      source: git(source, ["ls-tree", outside, "--", name]),
    }));
  const outsideRaw = JSON.stringify({
    ...spec,
    source: outside,
    controller: outside,
    inventory_sha256: bindingDigest(JSON.stringify(outsideInventory)),
  });
  await assert.rejects(
    () =>
      runHostedValidation("prepare", {
        ...options,
        environment: {
          ...environment,
          GITHUB_SHA: outside,
          GITHUB_WORKFLOW_SHA: outside,
          PORTCOVE_LOCAL_BINDING: outsideRaw,
          PORTCOVE_LOCAL_BINDING_SHA256: bindingDigest(outsideRaw),
        },
      }),
    /exceeds the independently admitted fifteen-path scope/,
  );
});

void test("candidate consumer binds four original product blobs and retains normal ancestry refusal", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-consumer-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const controller = path.join(directory, "controller");
  const git = (cwd: string, args: readonly string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  };
  const commit = (message: string) => {
    git(source, ["add", "."]);
    git(source, ["commit", "--quiet", "-m", message]);
    return git(source, ["rev-parse", "HEAD"]);
  };
  const tree = (sha: string) => git(source, ["rev-parse", `${sha}^{tree}`]);
  const products = [
    "apps/desktop/src/components/DetailPanel.tsx",
    "apps/desktop/src/components/DetailQualificationSummary.test.tsx",
    "apps/desktop/src/components/DetailQualificationSummary.tsx",
    "apps/desktop/src/components/components.test.tsx",
  ] as const;
  mkdirSync(source);
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.name", "Reviewed fixture"]);
  git(source, ["config", "user.email", "fixture@invalid"]);
  write("rust-toolchain.toml", 'channel = "1.98.1"\n');
  write("scripts/audit.mts", "preserved audit\n");
  const base = commit("actual base");
  for (const name of [
    ".github/workflows/ci.yml",
    ".github/workflows/native-design-compatibility.yml",
    "scripts/workflow-provenance.mts",
    "scripts/native-backup-evidence.mts",
  ])
    write(name, "reviewed controller\n");
  const control = commit("reviewed controller");
  git(directory, ["clone", "--quiet", source, controller]);
  git(source, ["checkout", "--quiet", "--detach", base]);
  for (const name of products) write(name, `original product ${name}\n`);
  const product = commit("original product");
  git(source, ["checkout", "--quiet", "--detach", control]);
  for (const name of products) write(name, `original product ${name}\n`);
  const composed = commit("reviewed composition");
  const inventory = (head: string) =>
    bindingDigest(
      JSON.stringify(
        git(source, ["diff", "--name-only", "--no-renames", base, head])
          .split("\n")
          .map((name) => ({
            path: name,
            base: git(source, ["ls-tree", base, "--", name]),
            source: git(source, ["ls-tree", head, "--", name]),
          })),
      ),
    );
  const spec = reviewedBinding({
    operation: "candidate-consumer",
    source: composed,
    controller: control,
    base,
    authority: base,
    merge_base: base,
    inventory_sha256: inventory(composed),
    consumer: {
      controller_tree: tree(control),
      source_tree: tree(composed),
      product_source: product,
      product_tree: tree(product),
    },
  });
  const options = (
    binding: Omit<typeof spec, "consumer"> & { consumer?: unknown } = spec,
    job = "hosted_history",
  ) => {
    const raw = JSON.stringify(binding);
    return {
      controllerRoot: controller,
      environment: {
        GITHUB_REPOSITORY: "boburning/portcove",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_SHA: control,
        GITHUB_WORKFLOW_SHA: control,
        GITHUB_WORKFLOW_REF:
          "boburning/portcove/.github/workflows/native-design-compatibility.yml@refs/heads/fixture",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: job,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        PORTCOVE_LOCAL_OPERATION: binding.operation,
        PORTCOVE_LOCAL_BINDING: raw,
        PORTCOVE_LOCAL_BINDING_SHA256: bindingDigest(raw),
      },
      command: (name: string, args: readonly string[], cwd: string) => {
        assert.equal(name, "git", "Binding tests must not execute native or candidate tools");
        return git(cwd, args);
      },
    };
  };
  for (const job of ["hosted_selected", "hosted_compiled", "hosted_history"])
    assert.equal(await runHostedValidation("prepare", options(spec, job)), 0);
  await assert.rejects(() => runHostedValidation("audit", options()), /Phase differs/);
  await assert.rejects(() => runHostedValidation("prepare", options(spec, "hosted_audit")), /job/);
  const { consumer, ...normal } = spec;
  await assert.rejects(() =>
    runHostedValidation("prepare", options({ ...normal, operation: "qualification-history" })),
  );
  for (const key of Object.keys(consumer))
    await assert.rejects(() =>
      runHostedValidation(
        "prepare",
        options({ ...spec, consumer: { ...consumer, [key]: "0".repeat(40) } }),
      ),
    );
  for (const patch of [{ command: "arbitrary" }, { consumer: {} }, { source: control }]) {
    const raw = JSON.stringify({ ...spec, ...patch });
    assert.throws(() => parseHostedValidationBinding(raw, bindingDigest(raw)));
  }
  for (const [name, expected] of [
    [products[0], /product bytes differ/],
    ["scripts/workflow-provenance.mts", /exactly the four/],
  ] as const) {
    write(name, "unreviewed composition change\n");
    const changed = commit("unreviewed change");
    await assert.rejects(
      () =>
        runHostedValidation(
          "prepare",
          options({
            ...spec,
            source: changed,
            inventory_sha256: inventory(changed),
            consumer: { ...consumer, source_tree: tree(changed) },
          }),
        ),
      expected,
    );
    git(source, ["checkout", "--quiet", "--detach", composed]);
  }
});

void test("preflight and controller share the exact hosted script authority boundary", () => {
  assert.equal(isHostedLocalCheckScriptAuthority("scripts/dev-doctor.mts"), true);
  assert.equal(isHostedLocalCheckScriptAuthority("apps/desktop/scripts/example.mjs"), true);
  assert.equal(isHostedLocalCheckScriptAuthority("scripts/example.test.mjs"), false);
  assert.equal(isHostedLocalCheckScriptAuthority("scripts/workflow-provenance.mts"), false);
  for (const file of [
    "scripts/nextest-outcomes-cli.mts",
    "scripts/nextest-skip-routes.mts",
    "scripts/standalone-rust-tests.mts",
    "scripts/development-evidence.mts",
    "scripts/operation-coverage.mts",
    "scripts/bounded-summary.mts",
    "scripts/fallow-summary.mts",
    "scripts/node-platform-skips.mts",
    "scripts/node-test-suites.mts",
    "scripts/node-test-suites.json",
    "apps/desktop/src/browser/failure-probe-contract.ts",
  ])
    assert.ok(
      isHostedLocalCheckScriptAuthority(file) && hostedLocalCheckAuthorityPaths.includes(file),
      file,
    );
  assert.match(
    runHostedValidation.toString(),
    /["']scripts\/nextest-skip-routes\.mts["']/u,
    "the protected bootstrap must preserve its actual skip-route input",
  );
  assert.match(
    runHostedValidation.toString(),
    /["']\.config\/rust-test-impact\.json["']/u,
    "the protected bootstrap must preserve its actual skip-route configuration",
  );
  assert.match(
    runHostedValidation.toString(),
    /["']scripts\/operation-coverage\.mts["']/u,
    "the frozen bootstrap preserves its actual operation-report dependency",
  );
  assert.equal(isHostedLocalCheckScriptAuthority("apps/desktop/src/example.ts"), false);
  assert.ok(hostedLocalCheckAuthorityPaths.includes("scripts/workflow-provenance.mts") === false);
});

function hostedFixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-local-check-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const controller = path.join(directory, "controller");
  const git = (cwd: string, args: readonly string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (cwd: string, name: string, value: string) => {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), value);
  };
  mkdirSync(source);
  git(source, ["init", "--quiet"]);
  git(source, ["config", "core.autocrlf", "false"]);
  git(source, ["config", "user.name", "Local binding fixture"]);
  git(source, ["config", "user.email", "fixture@example.invalid"]);
  for (const name of hostedLocalCheckAuthorityPaths) write(source, name, "authority\n");
  write(source, "rust-toolchain.toml", 'channel = "1.98.1"\n');
  write(source, ".node-version", process.version.slice(1) + "\n");
  write(source, "package.json", JSON.stringify({ packageManager: "pnpm@12.4.2" }));
  write(
    source,
    ".github/quality-tools.json",
    JSON.stringify({ tools: [{ id: "just", version: "1.58.0" }] }),
  );
  write(source, ".github/workflows/deep-quality.yml", "name: Deep audit\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "trusted authority"]);
  const base = git(source, ["rev-parse", "HEAD"]);
  write(source, "subject.rs", "reviewed source change\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "reviewed subject"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  git(directory, ["clone", "--quiet", source, controller]);
  git(controller, ["config", "core.autocrlf", "false"]);
  git(controller, ["config", "user.name", "Local binding fixture"]);
  git(controller, ["config", "user.email", "fixture@example.invalid"]);
  write(controller, ".github/workflows/deep-quality.yml", "name: Reviewed controller\n");
  git(controller, ["add", "."]);
  git(controller, ["commit", "--quiet", "-m", "reviewed controller"]);
  const controlHead = git(controller, ["rev-parse", "HEAD"]);
  const env: NodeJS.ProcessEnv = {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: controlHead,
    GITHUB_WORKFLOW_SHA: controlHead,
    GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/fixture",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    PORTCOVE_LOCAL_SOURCE_SHA: head,
    PORTCOVE_LOCAL_BASE_SHA: base,
    PORTCOVE_LOCAL_MERGE_BASE_SHA: base,
    PORTCOVE_LOCAL_CONTROLLER_SHA: controlHead,
    PORTCOVE_LOCAL_AUTHORITY_SHA: base,
    CI: "true",
    RUSTUP_TOOLCHAIN: "1.98.1",
    CARGO_INCREMENTAL: "0",
    PATH: process.env.PATH,
    GH_TOKEN: "fixture-secret",
  };
  const logs: string[] = [];
  const command: HostedCommand = (name, args, cwd) => {
    if (name === "git") return git(cwd, args);
    return lookup(
      {
        just: "just 1.58.0",
        rustc: "rustc 1.98.1 (fixture)",
        cargo: "cargo 1.98.1 (fixture)",
        pnpm: "12.4.2",
      },
      name,
    );
  };
  return {
    source,
    controller,
    git,
    write,
    env,
    head,
    base,
    logs,
    options: {
      controllerRoot: controller,
      environment: env,
      command,
      log: (line: string) => logs.push(line),
    },
  };
}

function browserProvisioningReport(
  f: Pick<ReturnType<typeof hostedFixture>, "head" | "base">,
  browser = true,
) {
  return {
    format_version: 1,
    source: f.head,
    base: f.base,
    merge_base: f.base,
    plan_digest: "d".repeat(64),
    obligations: [{ id: browser ? "ui-tests" : "diff-check", route: "local", missing: [] }],
  };
}

void test("preflight refusal retains bounded safe branch and transport facts", async (t) => {
  const f = hostedFixture(t);
  const valid = browserProvisioningReport(f);
  const secret = "secret-canary Ω https://signed.invalid/?token=secret-cookie";
  const cases: [string, unknown, number?][] = [
    ["json", secret],
    ["format-version", { ...valid, format_version: 2 }],
    ["source", { ...valid, source: secret }],
    ["base", { ...valid, base: f.head }],
    ["merge-base", { ...valid, merge_base: f.head }],
    ["plan-digest", { ...valid, plan_digest: secret }],
    ["status", { ...valid, status: "planning-blocked" }],
    ["obligations", { ...valid, obligations: null }],
    ["obligations-empty", { ...valid, obligations: [] }],
    ["obligation-id", { ...valid, obligations: [{ id: "" }] }],
    [
      "obligation-duplicate",
      { ...valid, obligations: [valid.obligations[0], valid.obligations[0]] },
    ],
    [
      "prerequisites",
      { ...valid, obligations: [{ id: secret, route: "blocked", missing: [secret] }] },
    ],
    ["audit-exit", valid, 1],
    [
      "obligation-duplicate",
      { ...valid, obligations: Array.from({ length: 1500 }, () => ({ id: secret })) },
    ],
  ];
  for (const [reason, report, status = 0] of cases) {
    f.logs.length = 0;
    let calls = 0;
    const stdout =
      typeof report === "string" ? report : JSON.stringify({ ...record(report), private: secret });
    await assert.rejects(
      runHostedLocalCheck("provision", {
        ...f.options,
        spawn: (_name, _args, settings) => {
          calls++;
          assert.equal(settings.timeout, 60_000);
          assert.equal(settings.maxBuffer, 8 * 1024 * 1024);
          return { status, stdout, stderr: secret };
        },
      }),
      /Invalid complete local-check preflight/,
    );
    assert.equal(calls, 1);
    const line = f.logs.find((value: string) => value.startsWith("Hosted preflight refusal: "));
    assert.ok(line, "Original refusal must retain a diagnostic");
    assert.ok(Buffer.byteLength(line) <= 64 * 1024);
    assert.ok(!line.includes("secret-canary") && !line.includes("signed.invalid"));
    assert.ok(line);
    const diagnostic = record(JSON.parse(line.slice("Hosted preflight refusal: ".length)));
    assert.equal(diagnostic.reason, reason);
    assert.equal(record(diagnostic.result).status, status);
    assert.equal(record(diagnostic.stdout).bytes, Buffer.byteLength(stdout));
    assert.equal(record(diagnostic.stdout).sha256, bindingDigest(stdout));
    assert.equal(diagnostic.capture_complete, true);
    if (isRecord(report) && Array.isArray(report.obligations) && report.obligations.length === 1500)
      assert.equal(diagnostic.omitted, true);
  }
  for (const code of ["ENOENT", "ETIMEDOUT", "ENOBUFS", "private-code"]) {
    f.logs.length = 0;
    const error = Object.assign(new Error(secret), { code });
    await assert.rejects(
      runHostedLocalCheck("provision", {
        ...f.options,
        spawn: () => ({
          error,
          status: null,
          signal: "SIGTERM",
          stdout: "partial Ω",
          stderr: secret,
        }),
      }),
      (actual) => actual === error,
    );
    const line = f.logs.find((value: string) => value.startsWith("Hosted preflight refusal: "));
    assert.ok(line);
    const diagnostic = record(JSON.parse(line.slice("Hosted preflight refusal: ".length)));
    assert.equal(diagnostic.reason, "child-error");
    assert.equal(diagnostic.capture_complete, false);
    assert.equal(record(diagnostic.result).code, code === "private-code" ? "UNKNOWN" : code);
    assert.equal(record(diagnostic.result).signal, "SIGTERM");
    assert.ok(!line.includes("secret-canary") && !line.includes("private-code"));
  }
  for (const status of [2, 7, null]) {
    f.logs.length = 0;
    assert.equal(
      await runHostedLocalCheck("provision", {
        ...f.options,
        spawn: () => ({ status, stdout: "{}" }),
      }),
      status ?? 1,
    );
    assert.ok(f.logs.some((line) => line.includes('"reason":"child-status"')));
  }
  await assert.rejects(
    runHostedLocalCheck("provision", {
      ...f.options,
      log: (line: string) => {
        if (line.startsWith("Hosted preflight refusal: ")) throw Error(secret);
      },
      spawn: () => ({ status: 0, stdout: "invalid" }),
    }),
    /Invalid complete local-check preflight/,
  );
});

void test("complete policy preflight exit one preserves audit and provisions selected browser", async (t) => {
  const f = hostedFixture(t);
  const calls: (readonly string[])[] = [];
  const report = {
    ...browserProvisioningReport(f),
    obligations: [{ id: "ui-tests", route: "local", missing: [] }],
    pre_change_audit: {
      profile: "complete",
      command: "just audit --profile transition --fresh",
      route: "local-prerequisites-unverified",
      stages: [{ id: "rust", command: "just check-rust" }],
      local_prerequisites: [{ id: "complete-audit-prerequisites", status: "unverified" }],
      missing_local_prerequisites: ["complete-audit-prerequisites"],
    },
  };
  assert.equal(
    await runHostedLocalCheck("provision", {
      ...f.options,
      spawn: (name, args) => {
        calls.push([name, ...args]);
        return name === process.execPath
          ? { status: 1, stdout: JSON.stringify(report) }
          : { status: 0 };
      },
    }),
    0,
  );
  assert.deepEqual(calls, [
    [process.execPath, "scripts/local-validation.mts", "check", "--preflight", "--json"],
    ["pnpm", "--dir", "apps/desktop", "browser:bootstrap"],
  ]);
  assert.ok(f.logs.some((line) => line.includes('"route":"local-prerequisites-unverified"')));
});

void test("selected hosted browser is provisioned before ordinary execution on a cold fixture", async (t) => {
  const f = hostedFixture(t);
  const calls: (readonly string[])[] = [];
  let browserReady = false;
  const spawn: NonNullable<HostedExecutionOptions["spawn"]> = (name, args, options) => {
    calls.push([name, ...args]);
    assert.equal(options.cwd, f.source);
    assert.equal(required(options.env).GH_TOKEN, undefined);
    assert.equal(required(options.env).CI, undefined);
    assert.equal(required(options.env).CARGO_BUILD_JOBS, "4");
    if (name === process.execPath)
      return { status: 0, stdout: JSON.stringify(browserProvisioningReport(f)) };
    if (name === "pnpm") {
      browserReady = true;
      return { status: 0 };
    }
    if (args.includes("--fresh")) assert.equal(browserReady, true);
    return { status: 0 };
  };
  assert.equal(await runHostedLocalCheck("provision", { ...f.options, spawn }), 0);
  assert.equal(await runHostedLocalCheck("run", { ...f.options, spawn }), 0);
  assert.deepEqual(calls, [
    [process.execPath, "scripts/local-validation.mts", "check", "--preflight", "--json"],
    ["pnpm", "--dir", "apps/desktop", "browser:bootstrap"],
    ["just", "local-check", "--plan"],
    ["just", "local-check", "--fresh"],
  ]);
  assert.ok(f.logs.some((line) => line.includes('"plan_digest":"' + "d".repeat(64))));
});

void test("provisioning refuses blocked selection and unnamed preflight failures", async (t) => {
  const f = hostedFixture(t);
  const report = browserProvisioningReport(f);
  const audit = {
    profile: "complete",
    route: "local-prerequisites-unverified",
    command: "just audit --profile transition --fresh",
  };
  for (const [status, value] of [
    [1, report],
    [1, { ...report, pre_change_audit: { ...audit, route: "hosted-deep-audit" } }],
    [1, { ...report, pre_change_audit: { ...audit, profile: "release" } }],
    [
      1,
      {
        ...report,
        pre_change_audit: { ...audit, command: "just audit --profile release --fresh" },
      },
    ],
    [
      1,
      {
        ...report,
        pre_change_audit: audit,
        obligations: [{ id: "ui-tests", route: "blocked", missing: ["ui-workspace"] }],
      },
    ],
    [
      1,
      {
        ...report,
        pre_change_audit: audit,
        obligations: [{ id: "ui-tests", route: "local", missing: ["node"] }],
      },
    ],
    [0, { ...report, obligations: [{ id: "ui-tests", route: "blocked", missing: ["pnpm"] }] }],
    [0, { ...report, obligations: [{ id: "ui-tests", route: "local" }] }],
  ] as const) {
    const calls: (readonly string[])[] = [];
    await assert.rejects(
      runHostedLocalCheck("provision", {
        ...f.options,
        spawn: (name, args) => {
          calls.push([name, ...args]);
          return { status, stdout: JSON.stringify(value) };
        },
      }),
      /Invalid complete local-check preflight/,
    );
    assert.equal(calls.length, 1);
  }
  for (const status of [2, 7, null]) {
    const calls: (readonly string[])[] = [];
    assert.equal(
      await runHostedLocalCheck("provision", {
        ...f.options,
        spawn: (name, args) => {
          calls.push([name, ...args]);
          return { status, stdout: JSON.stringify({ ...report, pre_change_audit: audit }) };
        },
      }),
      status ?? 1,
    );
    assert.equal(calls.length, 1);
  }
});

void test("browser-free hosted selection acquires nothing", async (t) => {
  const f = hostedFixture(t);
  const calls: (readonly string[])[] = [];
  assert.equal(
    await runHostedLocalCheck("provision", {
      ...f.options,
      spawn: (name, args) => {
        calls.push([name, ...args]);
        return { status: 0, stdout: JSON.stringify(browserProvisioningReport(f, false)) };
      },
    }),
    0,
  );
  assert.deepEqual(calls, [
    [process.execPath, "scripts/local-validation.mts", "check", "--preflight", "--json"],
  ]);
});

void test("failed preflight or browser acquisition cannot report provisioned readiness", async (t) => {
  for (const failure of ["preflight", "bootstrap"]) {
    const f = hostedFixture(t);
    const calls: (readonly string[])[] = [];
    assert.equal(
      await runHostedLocalCheck("provision", {
        ...f.options,
        spawn: (name, args) => {
          calls.push([name, ...args]);
          return name === process.execPath
            ? {
                status: failure === "preflight" ? 7 : 0,
                stdout: JSON.stringify(browserProvisioningReport(f)),
              }
            : { status: 9 };
        },
      }),
      failure === "preflight" ? 7 : 9,
    );
    assert.equal(calls.length, failure === "preflight" ? 1 : 2);
    assert.ok(
      !f.logs.some((line: string) => line.startsWith("Hosted browser provisioning completed:")),
    );
    assert.ok(!calls.some((call) => call.includes("--fresh")));
  }
});

void test("invalid or incomplete selected plan refuses acquisition", async (t) => {
  const f = hostedFixture(t);
  const report = browserProvisioningReport(f);
  for (const value of [
    "not JSON",
    { ...report, format_version: 2 },
    { ...report, source: f.base },
    { ...report, base: f.head },
    { ...report, merge_base: f.head },
    { ...report, plan_digest: "invalid" },
    { ...report, status: "planning-blocked" },
    { ...report, obligations: null },
    { ...report, obligations: [] },
    { ...report, obligations: [{ id: "" }] },
    { ...report, obligations: [{ id: "ui-tests" }, { id: "ui-tests" }] },
  ]) {
    const calls: (readonly string[])[] = [];
    await assert.rejects(
      runHostedLocalCheck("provision", {
        ...f.options,
        spawn: (name, args) => {
          calls.push([name, ...args]);
          return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) };
        },
      }),
      /Invalid complete local-check preflight/,
    );
    assert.equal(calls.length, 1);
  }
});

void test("provisioning rechecks clean source and comparison before and after acquisition", async (t) => {
  for (const change of ["source", "controller", "base", "bootstrap-source"]) {
    const f = hostedFixture(t);
    const calls: (readonly string[])[] = [];
    await assert.rejects(
      runHostedLocalCheck("provision", {
        ...f.options,
        spawn: (name, args) => {
          calls.push([name, ...args]);
          if (name === process.execPath) {
            if (change === "source") f.write(f.source, "subject.rs", "changed during preflight\n");
            if (change === "controller")
              f.write(f.controller, ".github/workflows/deep-quality.yml", "changed controller\n");
            if (change === "base")
              f.git(f.source, ["update-ref", "refs/remotes/origin/main", f.head]);
            return { status: 0, stdout: JSON.stringify(browserProvisioningReport(f)) };
          }
          f.write(f.source, "subject.rs", "changed during bootstrap\n");
          return { status: 0 };
        },
      }),
      /dirty|comparison target changed/,
    );
    assert.equal(calls.length, change === "bootstrap-source" ? 2 : 1);
  }
});

void test("hosted local execution preserves defaults and removes provisioning credentials", () => {
  const child = hostedLocalCheckEnvironment(
    {
      CI: "true",
      PATH: "/pinned/tools",
      RUSTUP_TOOLCHAIN: "1.98.1",
      GH_TOKEN: "private",
      ACTIONS_RUNTIME_TOKEN: "private",
    },
    "1.98.1",
  );
  assert.equal(child.PATH, "/pinned/tools");
  assert.equal(child.CARGO_BUILD_JOBS, "4");
  for (const name of [
    "CI",
    "RUSTUP_TOOLCHAIN",
    "CARGO_INCREMENTAL",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
  ])
    assert.ok(!(name in child));
  for (const name of [
    "RUSTFLAGS",
    "RUSTDOCFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_ENCODED_RUSTDOCFLAGS",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_TARGET",
    "CARGO_TARGET_DIR",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
    "CARGO_PROFILE_TEST_DEBUG",
    "CARGO_PROFILE_DEV_OPT_LEVEL",
    "NODE_OPTIONS",
    "PORTCOVE_TEST_FIXTURES",
    "PORTCOVE_HEAVY_RUST_WAIT_MS",
    "PORTCOVE_MIN_FREE_GIB",
    "PORTCOVE_TEMP_DIR",
    "PORTCOVE_OUTPUT_DIR",
    "PORTCOVE_PNPM_STORE_DIR",
    "PORTCOVE_SHARED_TOOL_CACHE",
    "PORTCOVE_HOST_TOOL_FIXTURE",
  ])
    assert.throws(
      () => hostedLocalCheckEnvironment({ [name]: "unsupported" }, "1.98.1"),
      /Unsupported.*override/,
    );
  assert.throws(
    () => hostedLocalCheckEnvironment({ CARGO_BUILD_JOBS: "8" }, "1.98.1"),
    /must be 4/,
  );
  assert.throws(
    () => hostedLocalCheckEnvironment({ RUSTUP_TOOLCHAIN: "nightly" }, "1.98.1"),
    /repository pin/,
  );
  assert.throws(
    () => hostedLocalCheckEnvironment({ pnpm_config_store_dir: "/unowned/store" }, "1.98.1"),
    /owned source checkout/,
  );
});

function cargoFixture(t: TestContext, twoManifests = false) {
  const f = hostedFixture(t);
  f.git(f.source, ["reset", "--hard", f.base]);
  const packageName = twoManifests ? "minisign-verify" : "minisign";
  const oldVersion = twoManifests ? "0.2.5" : "0.9.1";
  const newVersion = twoManifests ? "0.3.0" : "0.10.0";
  const manifests = [
    {
      path: "crates/portcove-release-tools/Cargo.toml",
      section: twoManifests ? "dependencies" : "dev-dependencies",
    },
  ];
  if (twoManifests)
    manifests.push({ path: "apps/desktop/src-tauri/Cargo.toml", section: "dependencies" });
  const checksum = "a".repeat(64);
  const nextChecksum = "b".repeat(64);
  const lock = `# Generated lock\nversion = 4\n\n[[package]]\nname = "${packageName}"\nversion = "${oldVersion}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n${twoManifests ? "" : 'dependencies = [\n "ct-codecs",\n]\n'}\n`;
  f.write(f.source, "Cargo.lock", lock);
  for (const entry of manifests)
    f.write(
      f.source,
      entry.path,
      `[package]\nname = "fixture"\nversion = "0.1.0"\n\n[${entry.section}]\n${packageName} = "${oldVersion}"\n`,
    );
  f.git(f.source, ["add", "."]);
  f.git(f.source, ["commit", "--quiet", "-m", "trusted Cargo authority"]);
  const authority = f.git(f.source, ["rev-parse", "HEAD"]);
  const nextLock = lock
    .replace(`version = "${oldVersion}"`, `version = "${newVersion}"`)
    .replace(checksum, nextChecksum);
  f.write(f.source, "Cargo.lock", nextLock);
  for (const entry of manifests)
    f.write(
      f.source,
      entry.path,
      readFileSync(path.join(f.source, entry.path), "utf8").replace(
        `"${oldVersion}"`,
        `"${newVersion}"`,
      ),
    );
  const spec: CargoMutationFixture = {
    package: packageName,
    from_version: oldVersion,
    to_version: newVersion,
    from_checksum: checksum,
    to_checksum: nextChecksum,
    lock_sha256: createHash("sha256").update(nextLock).digest("hex"),
    manifests,
  };
  const commit = () => {
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "reviewed dependency"]);
    f.env.PORTCOVE_LOCAL_SOURCE_SHA = f.git(f.source, ["rev-parse", "HEAD"]);
    f.env.PORTCOVE_LOCAL_BASE_SHA = authority;
    f.env.PORTCOVE_LOCAL_MERGE_BASE_SHA = authority;
    f.env.PORTCOVE_LOCAL_AUTHORITY_SHA = authority;
    f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = JSON.stringify(spec);
  };
  commit();
  return { ...f, spec, commit };
}

for (const count of [false, true]) {
  void test(`opt-in Cargo binding admits only the reviewed ${count ? "two" : "one"}-manifest update`, async (t) => {
    const f = cargoFixture(t, count);
    assert.equal(await runHostedLocalCheck("prepare", f.options), 0);
    const calls: { name: string; args: readonly string[]; options: SpawnSyncOptions }[] = [];
    assert.equal(
      await runHostedLocalCheck("run", {
        ...f.options,
        spawn: (name, args, options) => {
          calls.push({ name, args, options });
          return { status: 0 };
        },
      }),
      0,
    );
    assert.deepEqual(
      calls.map(({ name, args }) => [name, ...args]),
      [
        ["just", "local-check", "--plan"],
        ["just", "local-check", "--fresh"],
      ],
    );
    assert.ok(
      calls.every(
        ({ options }) =>
          required(options.env).GH_TOKEN === undefined &&
          required(options.env).CARGO_BUILD_JOBS === "4",
      ),
    );
    assert.ok(
      f.logs.some(
        (line) =>
          line.includes('"profile":"cargo-dependency"') && line.includes(text(f.spec.lock_sha256)),
      ),
    );
    delete f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING;
    await assert.rejects(runHostedLocalCheck("prepare", f.options), /changes trusted.*authority/);
  });
}

void test("Cargo binding rejects every other tree, mode and dependency-byte change", async (t) => {
  const mutations: ((f: ReturnType<typeof cargoFixture>) => void)[] = [
    (f) => f.write(f.source, "subject.rs", "extra source\n"),
    (f) => f.write(f.source, "scripts/local-validation.mts", "altered selector\n"),
    (f) => f.write(f.source, "Cargo.toml", "altered root\n"),
    (f) => f.write(f.source, ".cargo/config.toml", "altered flags\n"),
    (f) =>
      f.write(
        f.source,
        "Cargo.lock",
        readFileSync(path.join(f.source, "Cargo.lock"), "utf8") +
          '\n[[package]]\nname = "extra"\nversion = "1.0.0"\n',
      ),
    (f) =>
      f.write(
        f.source,
        "Cargo.lock",
        readFileSync(path.join(f.source, "Cargo.lock"), "utf8") + " \n",
      ),
    (f) =>
      f.write(
        f.source,
        "Cargo.lock",
        readFileSync(path.join(f.source, "Cargo.lock"), "utf8").replace(
          "registry+https://github.com/rust-lang/crates.io-index",
          "git+https://example.invalid",
        ),
      ),
    (f) =>
      f.write(
        f.source,
        required(f.spec.manifests[0]).path,
        readFileSync(path.join(f.source, required(f.spec.manifests[0]).path), "utf8").replace(
          'minisign = "0.10.0"',
          'minisign = { version = "0.10.0", default-features = false }',
        ),
      ),
    (f) =>
      f.write(
        f.source,
        required(f.spec.manifests[0]).path,
        readFileSync(path.join(f.source, required(f.spec.manifests[0]).path), "utf8") +
          '[dev-dependencies]\nminisign = "0.10.0"\n',
      ),
    (f) => f.git(f.source, ["rm", required(f.spec.manifests[0]).path]),
    (f) => {
      chmodSync(path.join(f.source, "Cargo.lock"), 0o755);
      f.git(f.source, ["update-index", "--chmod=+x", "Cargo.lock"]);
    },
  ];
  const f = cargoFixture(t);
  const originalHead = required(f.env.PORTCOVE_LOCAL_SOURCE_SHA);
  for (const mutate of mutations) {
    f.git(f.source, ["reset", "--hard", originalHead]);
    mutate(f);
    f.commit();
    await assert.rejects(
      runHostedLocalCheck("prepare", f.options),
      /Invalid reviewed Cargo dependency binding/,
    );
  }
});

void test("Cargo binding rejects ambiguous or unreviewed declarations and digests", async (t) => {
  const f = cargoFixture(t);
  const originalSpec = structuredClone(f.spec);
  for (const update of [
    (s) => {
      s.lock_sha256 = "c".repeat(64);
    },
    (s) => {
      s.to_checksum = "c".repeat(64);
    },
    (s) => {
      s.to_version = '0.10.0"\npath = "evil';
    },
    (s) => {
      s.manifests.push(required(s.manifests[0]));
    },
    (s) => {
      required(s.manifests[0]).path = "Cargo.toml";
    },
    (s) => {
      required(s.manifests[0]).section = "build-dependencies";
    },
    (s) => {
      s.extra = "ignored";
    },
    (s) => {
      s.package = [s.package];
    },
    (s) => {
      s.from_version = [s.from_version];
    },
    (s) => {
      s.to_checksum = [s.to_checksum];
    },
  ] satisfies ((s: CargoMutationFixture) => void)[]) {
    f.spec = structuredClone(originalSpec);
    update(f.spec);
    f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = JSON.stringify(f.spec);
    await assert.rejects(runHostedLocalCheck("prepare", f.options), /binding|digest/);
  }
  f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = JSON.stringify(originalSpec);
  f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING.replace(
    "{",
    '{"package":"hidden",',
  );
  await assert.rejects(runHostedLocalCheck("prepare", f.options), /binding/);
});

void test("Cargo binding is rechecked after provisioning and execution", async (t) => {
  const f = cargoFixture(t);
  assert.equal(await runHostedLocalCheck("prepare", f.options), 0);
  f.write(f.source, "Cargo.lock", "tampered provisioning\n");
  await assert.rejects(runHostedLocalCheck("run", f.options), /dirty/);
  f.git(f.source, ["checkout", "--", "Cargo.lock"]);
  await assert.rejects(
    runHostedLocalCheck("run", {
      ...f.options,
      spawn: () => {
        f.write(f.source, "Cargo.lock", "tampered execution\n");
        return { status: 0 };
      },
    }),
    /dirty/,
  );
});

void test("planning cannot change the reviewed lock before fresh execution", async (t) => {
  const f = cargoFixture(t);
  const calls: (readonly string[])[] = [];
  await assert.rejects(
    runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => {
        calls.push(args);
        f.write(f.source, "Cargo.lock", "metadata changed the graph\n");
        return { status: 0 };
      },
    }),
    /dirty/,
  );
  assert.deepEqual(calls, [["local-check", "--plan"]]);
  assert.ok(!f.logs.some((line: string) => line.startsWith("Hosted local-check completed:")));
});

for (const delimiter of ['"""', "'''"]) {
  void test(`multiline TOML ${delimiter} descriptions cannot masquerade as dependency tables`, async (t) => {
    const f = cargoFixture(t);
    f.git(f.source, ["reset", "--hard", required(f.env.PORTCOVE_LOCAL_AUTHORITY_SHA)]);
    const manifest = required(f.spec.manifests[0]).path;
    const text = `[package]\nname = "fixture"\nversion = "0.1.0"\ndescription = ${delimiter}\n[dev-dependencies]\nminisign = "0.9.1"\n${delimiter}\n\n[dev-dependencies] # actual table\nminisign = "0.9.1"\n`;
    f.write(f.source, manifest, text);
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "valid multiline authority"]);
    const authority = f.git(f.source, ["rev-parse", "HEAD"]);
    f.write(f.source, manifest, text.replace('minisign = "0.9.1"', 'minisign = "0.10.0"'));
    const lock = readFileSync(path.join(f.source, "Cargo.lock"), "utf8")
      .replace('version = "0.9.1"', 'version = "0.10.0"')
      .replace("a".repeat(64), "b".repeat(64));
    f.write(f.source, "Cargo.lock", lock);
    f.spec.lock_sha256 = createHash("sha256").update(lock).digest("hex");
    f.commit();
    f.env.PORTCOVE_LOCAL_AUTHORITY_SHA = authority;
    f.env.PORTCOVE_LOCAL_BASE_SHA = authority;
    f.env.PORTCOVE_LOCAL_MERGE_BASE_SHA = authority;
    await assert.rejects(
      runHostedLocalCheck("prepare", f.options),
      /Invalid reviewed Cargo dependency binding/,
    );
  });
}

void test("hosted execution binds actual Git source, default base, controller and final child", async (t) => {
  const f = hostedFixture(t);
  const calls: { name: string; args: readonly string[]; options: SpawnSyncOptions }[] = [];
  const status = await runHostedLocalCheck("run", {
    ...f.options,
    spawn: (name, args, options) => {
      calls.push({ name, args, options });
      assert.equal(f.git(f.source, ["rev-parse", "origin/main"]), f.base);
      assert.equal(required(options.env).CI, undefined);
      assert.equal(required(options.env).GH_TOKEN, undefined);
      assert.equal(required(options.env).CARGO_BUILD_JOBS, "4");
      assert.equal(required(options.env).CARGO_INCREMENTAL, undefined);
      assert.equal(required(options.env).RUNNER_TEMP, undefined);
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(
    calls.map(({ name, args }) => [name, ...args]),
    [
      ["just", "local-check", "--plan"],
      ["just", "local-check", "--fresh"],
    ],
  );
  assert.ok(
    calls.every((call) => call.options.cwd === f.source && call.options.stdio === "inherit"),
  );
  assert.ok(f.logs.some((line: string) => line.startsWith("Hosted local-check completed:")));
});

void test("hosted binding rejects frontend validation helper and test-policy changes", async (t) => {
  const f = hostedFixture(t);
  for (const name of [
    "apps/desktop/scripts/copy-lint-plugin.mts",
    "vite.config.ts",
    "scripts/browser-traces.ts",
    "tsconfig.json",
    "apps/desktop/vite.config.ts",
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/scripts/stylelint-config.mts",
    "scripts/tsconfig.json",
    "integrations/playnite/tsconfig.json",
    "apps/desktop/test/tsconfig.json",
    "apps/desktop/public/tsconfig.json",
    "tsconfig.base.json",
    "apps/desktop/i18next.config.ts",
    "apps/desktop/i18next.invalid.config.ts",
  ]) {
    f.git(f.source, ["reset", "--hard", f.head]);
    f.write(f.source, name, "process.exit(0);\n");
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "altered frontend validation"]);
    f.env.PORTCOVE_LOCAL_SOURCE_SHA = f.git(f.source, ["rev-parse", "HEAD"]);
    await assert.rejects(runHostedLocalCheck("prepare", f.options), /changes trusted.*authority/);
  }
});

void test("hosted binding rejects source, workflow, base, dirt and authority mismatches", async (t) => {
  const f = hostedFixture(t);
  for (const [name, value, message] of [
    ["PORTCOVE_LOCAL_SOURCE_SHA", "refs/heads/main", /Exact source/],
    ["GITHUB_WORKFLOW_SHA", "f".repeat(40), /controller context/],
    ["PORTCOVE_LOCAL_MERGE_BASE_SHA", f.head, /merge-base differs/],
    ["PORTCOVE_LOCAL_SOURCE_SHA", f.base, /checkout is dirty/],
  ] as const)
    await assert.rejects(
      runHostedLocalCheck("prepare", { ...f.options, environment: { ...f.env, [name]: value } }),
      message,
    );
  f.write(f.source, "untracked.rs", "dirty\n");
  await assert.rejects(runHostedLocalCheck("prepare", f.options), /checkout is dirty/);
  rmSync(path.join(f.source, "untracked.rs"));
  f.write(f.source, "scripts/local-validation.mts", "altered selector\n");
  f.git(f.source, ["add", "."]);
  f.git(f.source, ["commit", "--quiet", "-m", "altered authority"]);
  f.env.PORTCOVE_LOCAL_SOURCE_SHA = f.git(f.source, ["rev-parse", "HEAD"]);
  await assert.rejects(runHostedLocalCheck("prepare", f.options), /changes trusted.*authority/);
});

void test("hosted completion never upgrades failed, interrupted or altered execution", async (t) => {
  const f = hostedFixture(t);
  assert.equal(
    await runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => ({ status: args.includes("--fresh") ? 7 : 0 }),
    }),
    7,
  );
  assert.ok(!f.logs.some((line: string) => line.startsWith("Hosted local-check completed:")));
  assert.equal(
    await runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => ({ status: args.includes("--fresh") ? null : 0, signal: "SIGTERM" }),
    }),
    1,
  );
  await assert.rejects(
    runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => {
        if (args.includes("--fresh")) f.write(f.source, "subject.rs", "altered during execution\n");
        return { status: 0 };
      },
    }),
    /checkout is dirty/,
  );
  assert.ok(!f.logs.some((line: string) => line.startsWith("Hosted local-check completed:")));
});

void test("manual local-check transport preserves the audit and has no mutable execution inputs", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const local = workflow.split("\n  local_check:\n")[1];
  assert.ok(local);
  assert.match(
    workflow,
    /default: audit\n {8}options: \[audit, audit-reuse, local-check, fallow\]/,
  );
  const audit = workflow.split("\n  audit:\n")[1]?.split("\n  local_check:\n")[0];
  assert.ok(audit);
  assert.match(
    audit,
    /uses: actions\/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7\.1\.0\n {8}with:\n {10}python-version: "3\.12"/,
  );
  assert.ok(audit.indexOf("actions/setup-python@") < audit.indexOf("just audit --fresh"));
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /just audit --fresh/);
  assert.match(local, /runs-on: ubuntu-24\.04/);
  assert.equal((local.match(/persist-credentials: false/gu) ?? []).length, 2);
  assert.match(
    local,
    /hosted-local-check controller[\s\S]*path: source[\s\S]*hosted-local-check prepare[\s\S]*bootstrap-quality-tools\.sh[\s\S]*hosted-local-check run/,
  );
  // This workflow chooses Corepack only for frozen provisioning. Operations
  // subsequently resolve the installed local Vite+ CLI independently.
  assert.match(
    local,
    /working-directory: source\n        run: corepack pnpm install --frozen-lockfile/u,
  );
  assert.doesNotMatch(local, /run: pnpm install --frozen-lockfile/u);
  const install = local.indexOf("corepack pnpm install --frozen-lockfile");
  const provision = local.indexOf("hosted-local-check provision");
  const run = local.indexOf("hosted-local-check run");
  assert.ok(provision > install && run > provision);
  const provisioningStep = local.slice(local.lastIndexOf("      - name:", provision), run);
  assert.doesNotMatch(provisioningStep, /continue-on-error|if:.*always/);
  assert.doesNotMatch(
    local,
    /actions\/cache|rust-cache|upload-artifact|secrets\.|contents: write|CARGO_PROFILE_/,
  );
  assert.doesNotMatch(local, /run:.*\$\{\{ inputs\./);
});

const sha = (letter: string) => letter.repeat(40);
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
const build = (overrides: Partial<ProvenanceBuildOptions> = {}) =>
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

function storedZip(
  name: string,
  contents: string,
  options: { deflate?: boolean; declaredSize?: number } = {},
) {
  const decoded = Buffer.from(contents);
  const data = options.deflate ? deflateRawSync(decoded) : decoded;
  const declaredSize = options.declaredSize ?? decoded.length;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(options.deflate ? 8 : 0, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(options.deflate ? 8 : 0, 10);
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

void test("binds official workflow source context, checked-out code, and exact configurations", () => {
  const record = build();
  assert.equal(record.workflow.source_sha, sha("a"));
  assert.equal(record.workflow.caller_path, ".github/workflows/ci.yml");
  assert.equal(record.workflow.called_path, ".github/workflows/ci.yml");
  assert.equal(record.workflow.called_source_sha, sha("b"));
  assert.equal(record.checkout.sha, sha("b"));
  assert.equal(record.checkout.head_sha, sha("c"));
  assert.equal(record.format_version, 4);
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

void test("records unused package and Rust toolchains as not applicable", () => {
  const full = build();
  const record = build({
    observed: {
      ...full.observed,
      package_manager: null,
      rust: null,
      cargo: null,
    },
  });
  assert.deepEqual(record.matches, {
    node: true,
    package_manager: null,
    rust: null,
    cargo: null,
    build_configuration: true,
  });
  assert.equal(required(record.job_toolchains[0]).node, "24.21.0");
  assert.equal(required(record.job_toolchains[0]).rust, null);
  assert.equal(validateWorkflowProvenance(record, validationContext), record);
});

void test("binds a reusable workflow to both its top-level caller and called file", () => {
  const reusableEnvironment = {
    ...environment,
    GITHUB_WORKFLOW_REF: "example/repo/.github/workflows/qualification.yml@refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    PORTCOVE_CALLER: "schedule",
  };
  const record = build({ callerWorkflow: "qualification.yml", environment: reusableEnvironment });
  assert.equal(record.workflow.caller_path, ".github/workflows/qualification.yml");
  assert.equal(record.workflow.called_path, ".github/workflows/ci.yml");
  assert.equal(
    validateWorkflowProvenance(record, {
      ...validationContext,
      workflow: "qualification.yml",
      calledWorkflow: "ci.yml",
      event: "schedule",
    }),
    record,
  );
});

void test("rejects substituted workflow refs, checkout SHAs, and artifact identities", () => {
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

void test("rejects incomplete match evidence and substituted cohort identities", () => {
  const withoutMatches = build();
  // @ts-expect-error malformed receipt deliberately removes required match evidence.
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

void test("rejects missing plan, caller, and provenance-job toolchain identity", () => {
  assert.throws(() => build({ validationPlanDigest: "missing" }), /plan digest/u);
  assert.throws(() => build({ caller: "Bad caller" }), /caller/u);
  const missingJobs = build();
  missingJobs.job_toolchains = [];
  assert.throws(() => validateWorkflowProvenance(missingJobs, validationContext), /identity/u);

  const missingDesiredRust = build({
    // @ts-expect-error malformed provider data deliberately omits the required Rust pin.
    desired: {
      node: "24.21.0",
      package_manager: "12.4.1",
      build_configuration: { ci: true },
    },
    observed: {
      ...build().observed,
      rust: null,
      cargo: null,
    },
  });
  assert.throws(
    () => validateWorkflowProvenance(missingDesiredRust, validationContext),
    /identity/u,
  );
});

void test("extracts exactly one bounded provenance JSON file from an artifact ZIP", () => {
  const record = build();
  assert.deepEqual(
    parseProvenanceArchive(storedZip("workflow-provenance.json", JSON.stringify(record))),
    record,
  );
  assert.throws(() => parseProvenanceArchive(storedZip("other.json", "{}")), /one JSON/u);
});

void test("provider run identities require text instead of coercible numbers", () => {
  for (const malformed of [
    { ...environment, GITHUB_RUN_ID: 42 },
    { ...environment, GITHUB_RUN_ATTEMPT: 42 },
  ]) {
    assert.throws(() => {
      // @ts-expect-error provider boundary deliberately receives a numeric environment identity.
      build({ environment: malformed });
    }, /Invalid GITHUB_RUN/);
  }
});

void test("provenance deflate enforces its decoded bound before size comparison", () => {
  const limit = 1024 * 1024;
  const validJson = JSON.stringify("x".repeat(limit - 2));
  assert.equal(Buffer.byteLength(validJson), limit);
  assert.equal(
    parseProvenanceArchive(storedZip("workflow-provenance.json", validJson, { deflate: true })),
    "x".repeat(limit - 2),
  );
  const oversized = storedZip("workflow-provenance.json", " ".repeat(2 * limit), {
    deflate: true,
    declaredSize: 2,
  });
  assert.ok(oversized.length < 4096);
  assert.throws(() => parseProvenanceArchive(oversized), { code: "ERR_BUFFER_TOO_LARGE" });
});

void test("duplicate provenance entries refuse before decoding a second payload", () => {
  const json = JSON.stringify("x".repeat(1024 * 1024 - 2));
  const single = storedZip("workflow-provenance.json", json, { deflate: true });
  const footer = Buffer.from(single.subarray(single.length - 22));
  const directoryOffset = footer.readUInt32LE(16);
  const local = single.subarray(0, directoryOffset);
  const central = single.subarray(directoryOffset, single.length - 22);
  const secondLocal = Buffer.from(local);
  const dataOffset = 30 + secondLocal.readUInt16LE(26) + secondLocal.readUInt16LE(28);
  // If the parser reaches this duplicate's decoder, it raises Z_DATA_ERROR.
  secondLocal[dataOffset] = 0xff;
  const secondCentral = Buffer.from(central);
  secondCentral.writeUInt32LE(local.length, 42);
  footer.writeUInt16LE(2, 8);
  footer.writeUInt16LE(2, 10);
  footer.writeUInt32LE(central.length * 2, 12);
  footer.writeUInt32LE(local.length * 2, 16);
  const duplicate = Buffer.concat([local, secondLocal, central, secondCentral, footer]);
  assert.ok(duplicate.length < 4096);
  assert.throws(() => parseProvenanceArchive(duplicate), /must contain one JSON record/);
});

void test("Linux continuity publishes an outside-checkout store and lossless bounded private-free reports", async (t) => {
  const workflow: unknown = parseYaml(
    readFileSync(
      new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = record(record(record(workflow).jobs).linux_preparation_continuity);
  assert.ok(!Object.hasOwn(record(job.env), "PORTCOVE_RETAINED_EVIDENCE_DIR"));
  assert.ok(Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const nodeSetup = record(
    required(steps.find((value) => text(record(value).uses).startsWith("actions/setup-node@"))),
  );
  const nodeOptions = record(nodeSetup.with);
  assert.equal(nodeOptions["package-manager-cache"], false);
  assert.ok(!Object.hasOwn(nodeOptions, "cache"));
  assert.ok(!Object.hasOwn(nodeOptions, "cache-dependency-path"));
  const extract = (name: string) => {
    const step = record(required(steps.find((value) => record(value).name === name)));
    return required(
      text(step.run).match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n?$/u)?.[1],
    );
  };
  const environmentProgram = extract(
    "Retain the exact ordinary hosted environment before preparation",
  );
  const collector = extract("Retain bounded Linux reports and images in ordinary job logs");
  assert.ok(!JSON.stringify(job).includes("actions/upload-artifact"));
  const temporary = mkdtempSync(path.join(tmpdir(), "portcove-linux-evidence-"));
  const relative = path.relative(tmpdir(), temporary);
  assert.ok(relative.startsWith("portcove-linux-evidence-") && !relative.includes(".."));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const checkout = path.join(temporary, "checkout");
  const runnerTemporary = path.join(temporary, "runner-temp");
  mkdirSync(checkout);
  mkdirSync(runnerTemporary);
  const environmentFile = path.join(temporary, "environment");
  const environment = {
    ...process.env,
    RUNNER_TEMP: runnerTemporary,
    GITHUB_ENV: environmentFile,
    GITHUB_SHA: "a".repeat(40),
  };
  const stubbedEnvironment = [
    "import cp from 'node:child_process';",
    "import {syncBuiltinESMExports} from 'node:module';",
    "cp.execFileSync=(command,args)=>{",
    " if(command==='git')return args.includes('--porcelain')?'':'a'.repeat(40);",
    " if(['uname','pnpm','rustc'].includes(command))return 'fixture version';",
    " throw new Error('Unexpected environment command'); };",
    "syncBuiltinESMExports();",
    "await import('data:text/javascript,'+encodeURIComponent(" +
      JSON.stringify(environmentProgram) +
      "));",
  ].join("\n");
  const observed = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", stubbedEnvironment],
    {
      cwd: checkout,
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(observed.status, 0, observed.stderr);
  const retained = path.join(runnerTemporary, "slice3-native-retained");
  assert.equal(
    readFileSync(environmentFile, "utf8"),
    "PORTCOVE_RETAINED_EVIDENCE_DIR=" + retained + "\n",
  );
  assert.ok(path.relative(checkout, retained).startsWith(".." + path.sep));
  const root = path.join(checkout, "work/linux-preparation-continuity");
  assert.equal(
    record(JSON.parse(readFileSync(path.join(root, "host.json"), "utf8"))).retained_evidence,
    retained,
  );
  const fixture: Record<string, string> = {
    "driver-help.txt": "exact driver inventory\n",
    "cancellation/report.json": '{"result":"cancelled"}\n',
    "cancellation/screenshot.png": "unit fixture image bytes",
    "interruption/report.json": '{"result":"recovered"}\n',
    "private-x11-abc123/preflight.json": '{"identity":"owned"}\n',
    "private-x11-abc123/outer-join.json": '{"closed":true}\n',
    "cancellation/library/private.json": "private library bytes",
    "private-x11-abc123/xdg_config_home/private.json": "private profile bytes",
    "private-x11-abc123/private-authority": "private cookie",
    "retained.exe": "binary payload",
  };
  for (const [name, bytes] of Object.entries(fixture)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  mkdirSync(path.join(checkout, "scripts"));
  for (const file of ["native-backup-evidence.mts", "runtime-values.mts"])
    writeFileSync(
      path.join(checkout, "scripts", file),
      readFileSync(new URL("./" + file, import.meta.url)),
    );
  const collected = spawnSync(process.execPath, ["--input-type=module", "--eval", collector], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(collected.status, 0, collected.stderr);
  const decoded = path.join(temporary, "decoded");
  await recoverBackupEvidence(collected.stdout, decoded);
  const inventory = record(
    JSON.parse(readFileSync(path.join(decoded, "collection.json"), "utf8")),
  ).inventory;
  assert.ok(Array.isArray(inventory));
  assert.deepEqual(
    inventory
      .map((value: unknown) => text(record(value).original).split(path.sep).join("/"))
      .sort(),
    [
      "cancellation/report.json",
      "cancellation/screenshot.png",
      "driver-help.txt",
      "host.json",
      "interruption/report.json",
      "private-x11-abc123/outer-join.json",
      "private-x11-abc123/preflight.json",
    ],
  );
  for (const value of inventory) {
    const entry = record(value);
    const bytes = readFileSync(
      path.join(decoded, "desktop-verify/slice3/native", text(entry.retained)),
    );
    assert.deepEqual(bytes, readFileSync(path.join(root, text(entry.original))));
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(entry.bytes, bytes.length);
  }
});
