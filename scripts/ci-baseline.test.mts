import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildValidationPlan } from "./validation-plan.mts";
import { discoverCiPlan } from "./select-ci-plan.mts";
import { buildPlan, classifyChanges } from "./local-validation.mts";
import { windowsHelperChecksRequired } from "./windows-helper-checks.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";
import {
  baselineContractTests,
  baselineFrontendPlan,
  baselineLintPlan,
  baselineIntegrityCommands,
  baselineBootstrapTests,
  baselineTestEnvironment,
  baselineSelection,
  baselineRequiresPython,
  baselineRequiresRust,
  baselineRequiresDesktopDependencies,
} from "./ci-baseline.mts";

void test("unknown and empty hosted plans retain every catalog generator family", () => {
  const unknown = make(["unknown/input.bin"]);
  assert.ok(unknown.fallback);
  const empty = buildValidationPlan({
    changes: [],
    eventName: "workflow_dispatch",
    checkout: "b".repeat(40),
  });
  assert.equal(empty.mode, "fast");
  assert.equal(empty.changes.length, 0);
  assert.equal(empty.fallback, null);
  for (const plan of [unknown, empty]) {
    const selected = baselineContractTests(plan, { fileExists: () => false });
    for (const file of [
      "scripts/generate-catalog.test.mts",
      "scripts/catalog-source-authoring.test.mts",
      "scripts/catalog-proposal-comparison.test.mts",
      "scripts/catalog-artwork-dispatch.test.mts",
      "scripts/catalog-artwork-batches.test.mts",
      "scripts/catalog-artwork-provider.test.mts",
      "scripts/catalog-artwork-lifecycle.test.mts",
      "scripts/catalog-artwork-backoff.test.mts",
    ]) {
      assert.equal(selected.filter((entry) => entry === file).length, 1, file);
    }
  }
});
void test("Linux reviewer boundary edits retain protected ownership and Python contract execution", () => {
  for (const file of [
    "scripts/semantic-review-linux-supervisor.py",
    "scripts/semantic-review-linux-supervisor.test.py",
    "scripts/semantic-review-linux-supervisor.test.mts",
    "scripts/qualify-semantic-linux.mts",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    assert.ok(
      baselineContractTests(plan).includes("scripts/semantic-review-linux-supervisor.test.mts"),
      file,
    );
    assert.ok(baselineRequiresPython(plan), file);
  }
});

void test("semantic source acquisition retains release ownership and its Python parser boundary contracts", () => {
  for (const file of [
    "scripts/release-semantic-source.mts",
    "scripts/semantic-source-git.py",
    "scripts/semantic-source-git.test.py",
    "scripts/qualify-semantic-source.mts",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    assert.ok(
      baselineContractTests(plan).includes("scripts/release-semantic-source.test.mts"),
      file,
    );
    assert.ok(baselineRequiresPython(plan), file);
  }
});

const make = (files: string[]) =>
  buildValidationPlan({
    changes: files.map((file: string) => ({
      status: "M",
      oldMode: file.endsWith(".sh") ? "100755" : "100644",
      newMode: file.endsWith(".sh") ? "100755" : "100644",
      oldPath: file,
      newPath: file,
    })),
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });

void test("Python result helpers retain every real suite consumer and its interpreter", () => {
  const expected = [
    "scripts/python-test-results.test.mts",
    "scripts/native-linux-isolated-init.test.mts",
    "scripts/native-qualification-linux-supervisor.test.mts",
    "scripts/native-qualification-linux-transfer.test.mts",
    "scripts/native-linux-public-fuse.test.mts",
    "scripts/native-linux-public-network.test.mts",
    "scripts/native-linux-public-services.test.mts",
    "scripts/semantic-review-linux-supervisor.test.mts",
    "scripts/release-semantic-source.test.mts",
  ];
  for (const file of ["scripts/python-test-results.py", "scripts/python-test-results.mts"]) {
    const plan = make([file]);
    const selected = baselineContractTests(plan);
    for (const consumer of expected) assert.ok(selected.includes(consumer), `${file}: ${consumer}`);
    assert.ok(baselineRequiresPython(plan), file);
  }
  for (const file of expected) assert.ok(baselineRequiresPython(make([file])), file);
});

void test("shared diagnostics inputs keep hosted frontend and quality plans runnable", () => {
  for (const file of [
    "crates/portcove-diagnostics/Cargo.toml",
    "crates/portcove-diagnostics/src/lib.rs",
    "crates/portcove-diagnostics/src/sessions/tests.rs",
  ]) {
    const plan = make([file]);
    assert.equal(plan.fallback, null, file);
    assert.ok(plan.groups.includes("rust"), file);
    assert.ok(plan.groups.includes("rust-quality"), file);
    assert.equal(baselineSelection(plan).unknown.size, 0, file);
    assert.doesNotThrow(() => baselineLintPlan(plan), file);

    const mixed = make([file, "apps/desktop/src/App.tsx"]);
    assert.ok(
      baselineFrontendPlan(mixed).some((entry) => entry.id === "ui-build"),
      file,
    );
    assert.doesNotThrow(() => baselineLintPlan(mixed), file);
  }
});

void test("native source declarations start their cheap hosted consumer without release qualification", () => {
  const contract = "scripts/release-native-source-contract.test.mts";
  for (const source of nativeCompatibilitySourcePaths) {
    const plan = make([source]);
    assert.ok(plan.groups.includes("catalog"), source);
    assert.ok(plan.groups.includes("rust"), source);
    assert.equal(baselineContractTests(plan).filter((file) => file === contract).length, 1, source);
    assert.equal(baselineRequiresDesktopDependencies(plan), true, source);
  }
  for (const source of [
    "crates/portcove-core/src/database.rs",
    "crates/portcove-core/src/lib.rs",
  ]) {
    const plan = make([source]);
    assert.deepEqual(plan.groups, ["catalog", "rust", "rust-quality"]);
    assert.equal(plan.mode, "fast");
    assert.equal(plan.qualification_required, false);
    assert.equal(plan.areas.includes("release-security"), false);
    assert.equal(
      baselineRequiresRust(plan),
      false,
      "source declaration contracts do not compile Rust",
    );
  }
  assert.equal(
    baselineContractTests(make(["crates/portcove-core/src/source_report.rs"])).includes(contract),
    false,
  );
  assert.equal(
    baselineRequiresDesktopDependencies(make(["crates/portcove-core/src/source_report.rs"])),
    false,
  );
  assert.equal(baselineRequiresDesktopDependencies(make(["docs/README.md"])), false);
  for (const source of [
    "scripts/release-native-candidate.mts",
    "scripts/release-native-source-contract.mts",
    "scripts/release-native-source-contract.test.mts",
  ])
    assert.equal(baselineRequiresDesktopDependencies(make([source])), true, source);
  assert.equal(
    baselineRequiresDesktopDependencies(
      buildValidationPlan({
        changes: [],
        eventName: "pull_request",
        checkout: "b".repeat(40),
        discovery: "failed",
        blockedReason: "fixture",
      }),
    ),
    false,
  );
});

void test("storage metadata contracts provision pinned Rust for direct and indirect selection", () => {
  for (const file of [
    "scripts/dev-storage.mts",
    "scripts/dev-storage.test.mts",
    "justfile",
    "package.json",
  ]) {
    const plan = make([file]);
    assert.ok(baselineContractTests(plan).includes("scripts/dev-storage.test.mts"));
    assert.equal(baselineRequiresRust(plan), true);
  }
  assert.equal(baselineRequiresRust(make(["docs/README.md"])), false);
});

void test("local and hosted lint use one full stage for relevant inputs, including rename and deletion", () => {
  for (const file of [
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/app.css",
    "scripts/tool.test.mjs",
    "scripts/new.ts",
    "vite.config.ts",
    ".node-version",
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/scripts/stylelint-config.mts",
    "apps/desktop/tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "unknown/input.bin",
    "apps/desktop/assets/unmapped.bin",
  ]) {
    const plan = make([file]);
    const hosted = baselineLintPlan(plan);
    assert.ok(hosted[0]);
    assert.equal(hosted.length, 1, file);
    assert.equal(hosted[0].id, "repository-lint");
    assert.equal(hosted[0].executable, process.execPath);
    assert.deepEqual(hosted[0].args, [
      "scripts/run-viteplus.mts",
      "run",
      file.startsWith("scripts/") ? "repository:static" : "frontend:static",
    ]);
    assert.equal(path.resolve(hosted[0].cwd), process.cwd());
    assert.deepEqual(
      hosted,
      buildPlan(baselineSelection(plan), { validationPlan: plan }).filter(
        (entry) => entry.id === "repository-lint",
      ),
    );
  }
  for (const file of ["docs/QUALITY.md", "Cargo.toml"])
    assert.equal(baselineLintPlan(make([file]))[0]?.id, "oxfmt", file);
  for (const file of [
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/public/logo.png",
    "apps/desktop/src/artwork.png",
  ])
    assert.deepEqual(baselineLintPlan(make([file])), [], file);
  const changes = [
    {
      status: "R100",
      oldPath: "scripts/old.mjs",
      newPath: "docs/old.md",
      oldMode: "100644",
      newMode: "100644",
    },
    {
      status: "D",
      oldPath: "apps/desktop/src/old.tsx",
      newPath: "apps/desktop/src/old.tsx",
      oldMode: "100644",
      newMode: "000000",
    },
  ];
  for (const change of changes) {
    const plan = buildValidationPlan({
      changes: [change],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    assert.equal(baselineLintPlan(plan).length, 1, change.status);
  }
  assert.equal(baselineLintPlan(make(["scripts/a.mjs", "apps/desktop/src/App.tsx"])).length, 1);
});

void test("first pushes and missing historical bases retain full lint without changed-file entries", () => {
  const options = {
    eventName: "push",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    checkoutSha: "b".repeat(40),
    fastValidationEnabled: true,
    proseOnlyEnabled: true,
  };
  const first = discoverCiPlan({ ...options, baseSha: "0".repeat(40) }, () =>
    assert.fail("first push needs no historical Git reads"),
  );
  const missing = discoverCiPlan(options, (args) => {
    if (args[0] === "cat-file" && args[2]?.startsWith("a".repeat(40)))
      throw Object.assign(new Error("missing base"), { status: 128 });
    return Buffer.alloc(0);
  });
  for (const plan of [first, missing]) {
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.fallback, null);
    assert.equal(plan.groups.length, 5);
    const local = buildPlan(baselineSelection(plan), { validationPlan: plan }).filter(
      (entry) => entry.id === "repository-lint",
    );
    assert.equal(local.length, 1);
    assert.deepEqual(baselineLintPlan(plan), local);
  }
});
void test("unknown ownership executes the canonical static group exactly once", () => {
  const plan = make(["unknown/input.bin"]);
  const commands = buildPlan(baselineSelection(plan), { validationPlan: plan });
  assert.equal(commands.filter((entry) => entry.args.includes("frontend:static")).length, 1);
});
void test("Playnite and handoff repairs select their cheap regressions in ordinary CI", () => {
  const tests = baselineContractTests(
    make(["integrations/playnite/check.ps1", "scripts/handoff-evidence.mts"]),
  );
  assert.ok(tests.includes("integrations/playnite/lifecycle-check.test.mts"));
  assert.ok(tests.includes("scripts/handoff-evidence.test.mts"));
});
void test("bootstrap regressions are limited to infrastructure, including old rename paths", () => {
  assert.deepEqual(baselineBootstrapTests(make(["crates/portcove-core/src/lib.rs"])), []);
  assert.deepEqual(baselineBootstrapTests(make([".github/workflows/ci.yml"])), [
    "scripts/rust-support-cache.test.mts",
  ]);
  const renamed = make(["scripts/new-runner.mjs"]);
  assert.ok(renamed.changes[0]);
  renamed.changes[0].oldPath = "scripts/run-rust-tests.mts";
  renamed.changes[0].status = "R100";
  // Rebuild the validated plan so its digest and discovery stay coherent.
  const plan = buildValidationPlan({
    changes: renamed.changes,
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  assert.deepEqual(baselineBootstrapTests(plan), ["scripts/rust-support-cache.test.mts"]);
});
void test("Windows archive helper and timing edits retain Rust execution and their causal contracts", () => {
  const contracts = [
    "scripts/ci-workflow.test.mts",
    "scripts/ci-result-gate.test.mts",
    "scripts/ci-baseline.test.mts",
    "scripts/rust-test-impact.test.mts",
  ];
  for (const file of ["scripts/windows-rust-tests.mts", ".config/rust-test-timing-hints.json"]) {
    for (const change of [
      { status: "M", path: file },
      { status: "A", path: file },
      { status: "D", path: file },
      { status: "R100", path: "docs/windows-test-routing.md", previousPath: file },
      { status: "R100", path: file, previousPath: "docs/windows-test-routing.md" },
    ]) {
      const label = JSON.stringify(change);
      const plan = buildValidationPlan({
        changes: [
          {
            status: change.status,
            oldPath: change.previousPath ?? change.path,
            newPath: change.path,
            oldMode: change.status === "A" ? "000000" : "100644",
            newMode: change.status === "D" ? "000000" : "100644",
          },
        ],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      assert.equal(plan.mode, "fast", label);
      assert.equal(plan.fallback, null, label);
      assert.deepEqual(plan.groups, ["catalog", "rust", "rust-quality"], label);
      assert.ok(plan.areas.includes("policy"), label);
      const local = classifyChanges([change], { fileExists: () => false });
      assert.equal(local.unknown.size, 0, label);
      assert.ok(local.workspaceRust && local.workspaceRustTests, label);
      assert.ok(
        buildPlan(local, { validationPlan: plan }).some(
          (entry) => entry.id === "rust-workspace-tests",
        ),
        label,
      );
      const hosted = baselineContractTests(plan, { fileExists: () => false });
      for (const contract of contracts) {
        assert.ok(local.nodeTests.has(contract), `${label}: local ${contract}`);
        assert.equal(hosted.filter((test) => test === contract).length, 1, `${label}: ${contract}`);
      }
      assert.ok(hosted.includes("scripts/qualification-coverage.test.mts"), label);
      assert.equal(baselineRequiresPython(plan), true, label);
    }
  }
});
void test("hosted contracts retain relevant script/docs/schema tests without stateful qualification", () => {
  const p = make(["scripts/run-rust-tests.mts", "docs/QUALITY.md"]);
  const tests = baselineContractTests(p);
  for (const file of [
    "scripts/run-rust-tests.test.mts",
    "scripts/heavy-rust-test-lock.test.mts",
    "scripts/repository-settings.test.mts",
  ])
    assert.ok(tests.includes(file));
  assert.ok(!tests.includes("scripts/windows-qualification-session.integration.test.mts"));
});

void test("release run evidence contracts are selected for implementation and test changes", () => {
  for (const changed of [
    "scripts/release-run-evidence.mts",
    "scripts/release-run-evidence.test.mts",
  ]) {
    const plan = make([changed]);
    assert.ok(plan.areas.includes("release-security"));
    assert.ok(plan.groups.includes("catalog"));
    assert.ok(baselineContractTests(plan).includes("scripts/release-run-evidence.test.mts"));
  }
});
void test("payload signer and held caller changes preserve release security and both connected contracts", () => {
  for (const file of [
    "scripts/release-payload-signing.mts",
    "scripts/release-payload-preparation.mts",
    "docs/qualification/application-update-production.payload-signing.yml",
    "docs/qualification/application-update-production.aggregate.yml",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    const tests = baselineContractTests(plan);
    assert.ok(tests.includes("scripts/release-payload-signing.test.mts"), file);
    assert.ok(tests.includes("scripts/release-payload-preparation.test.mts"), file);
    const local = classifyChanges([{ status: "M", path: file }]);
    assert.ok(local.nodeTests.has("scripts/release-payload-signing.test.mts"), file);
    assert.ok(local.nodeTests.has("scripts/release-payload-preparation.test.mts"), file);
  }
});
void test("shared and unknown frontend inputs use full units; sources use the related graph", () => {
  const related = baselineFrontendPlan(make(["apps/desktop/src/App.tsx"]));
  assert.ok(
    related.findIndex((entry) => entry.id === "ui-content") <
      related.findIndex((entry) => entry.id === "ui-build"),
  );
  assert.ok(related.some((entry) => entry.id === "ui-related-tests"));
  const selected = related.find((entry) => entry.id === "ui-related-tests");
  assert.ok(selected);
  assert.deepEqual(selected.args.slice(0, 2), ["scripts/run-ui-tests.mts", "related"]);
  for (const p of [make(["apps/desktop/tsconfig.json"]), make(["unknown/new-input.bin"])]) {
    const full = baselineFrontendPlan(p);
    assert.ok(full.some((entry) => entry.id === "ui-tests"));
    assert.ok(!full.some((entry) => entry.id === "ui-related-tests"));
  }
  assert.throws(() => baselineFrontendPlan(make(["docs/QUALITY.md"])));
});

void test("selected contract tests retain cheap actual-checkout integrity", () => {
  const catalog = baselineIntegrityCommands(make(["crates/portcove-core/catalog/catalog.json"]));
  assert.ok(
    catalog.some((args) => args[0] === "scripts/generate-catalog.mts" && args[1] === "--check"),
  );
  assert.ok(
    catalog.some(
      (args) => args[0] === "scripts/check-retcomm-upstreams.mts" && args[1] === "--offline",
    ),
  );
  const docs = baselineIntegrityCommands(make(["docs/QUALITY.md"]));
  assert.ok(
    docs.some((args) => args[0] === "scripts/repository-settings.mts" && args[1] === "--validate"),
  );
  assert.ok(!docs.some((args) => args[0] === "scripts/generate-catalog.mts"));
});

void test("ordinary selected checking retains CSS correctness", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(manifest) && isRecord(manifest.scripts));
  assert.equal(manifest.scripts.check, "vp run frontend:static");
  assert.match(
    readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"),
    /vp -C apps\/desktop run lint:style/u,
  );
  assert.deepEqual(baselineLintPlan(make(["apps/desktop/src/app.css"]))[0]?.args, [
    "scripts/run-viteplus.mts",
    "run",
    "frontend:static",
  ]);
});

void test("Python is provisioned for the effective TOML positive contracts, not ordinary prose", () => {
  assert.equal(baselineRequiresPython(make(["scripts/nextest-equivalence.mts"])), true);
  assert.equal(baselineRequiresPython(make(["scripts/ci-workflow.test.mts"])), true);
  assert.equal(baselineRequiresPython(make(["docs/QUALITY.md"])), false);
});

void test("desktop runner selects the same complete contract union in local and hosted production plans", () => {
  const file = "apps/desktop/scripts/desktop-test.mts";
  const expected = [
    "scripts/desktop-execution-plan.test.mts",
    "scripts/desktop-scenarios.test.mts",
    "scripts/desktop-verify.test.mts",
    "scripts/frontend-command-preflight.test.mts",
    "scripts/native-helper-dependencies.test.mts",
    "scripts/windows-helper-checks.test.mts",
    "scripts/development-evidence.test.mts",
    "scripts/native-session-lock.test.mts",
  ];
  const changes = [
    { status: "M", path: file },
    { status: "D", path: file },
    { status: "R100", path: "apps/desktop/scripts/renamed.mts", previousPath: file },
  ];
  for (const change of changes) {
    const local = classifyChanges([change], { fileExists: () => false });
    // Classification is shared, while Windows execution remains independently selected.
    const hosted = buildValidationPlan({
      changes: [
        {
          status: change.status,
          oldPath: file,
          newPath: change.path,
          oldMode: "100644",
          newMode: change.status === "D" ? "000000" : "100644",
        },
      ],
      eventName: "pull_request",
      base: "a".repeat(40),
      mergeBase: "a".repeat(40),
      head: "b".repeat(40),
      checkout: "b".repeat(40),
    });
    const actualHosted = baselineContractTests(hosted, { fileExists: () => false });
    for (const name of expected) {
      assert.ok(local.nodeTests.has(name), `${change.status}: local ${name}`);
      assert.ok(actualHosted.includes(name), `hosted ${name}`);
    }
    const command = buildPlan(local).find((entry) => entry.id === "node-tests");
    assert.ok(command);
    for (const name of expected) assert.ok(command.args.includes(name), `execution: ${name}`);
    assert.equal(windowsHelperChecksRequired(hosted), true);
    assert.equal(local.workspaceRust, false);
  }
});

void test("semantic helper-only changes retain their actual broker consumer locally and hosted", () => {
  for (const name of ["reader", "reader-core", "reader-server", "runtime", "inputs"]) {
    const file = `scripts/release-semantic-${name}.mts`;
    for (const change of [
      { status: "M", path: file },
      { status: "D", path: file },
      { status: "R100", path: "scripts/moved-helper.mts", previousPath: file },
      { status: "R100", previousPath: "scripts/moved-helper.mts", path: file },
    ]) {
      const local = classifyChanges([change], { fileExists: () => false });
      assert.ok(
        local.nodeTests.has("scripts/release-semantic-broker.test.mts"),
        JSON.stringify(change),
      );
      const plan = buildValidationPlan({
        changes: [
          {
            status: change.status,
            oldPath: change.previousPath ?? change.path,
            newPath: change.path,
            oldMode: "100644",
            newMode: change.status === "D" ? "000000" : "100644",
          },
        ],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      assert.ok(plan.areas.includes("release-security"));
      assert.ok(
        baselineContractTests(plan, { fileExists: () => false }).includes(
          "scripts/release-semantic-broker.test.mts",
        ),
      );
    }
  }
  assert.ok(
    !classifyChanges([{ status: "M", path: "scripts/ui-test-selection.mts" }]).nodeTests.has(
      "scripts/release-semantic-broker.test.mts",
    ),
  );
});

void test("fixed controller bootstrap and shared attestation verifier retain protected release ownership", () => {
  for (const file of [
    "scripts/release-controller-tool-build.mts",
    "scripts/qualify-controller-tool-build.mts",
    ".github/workflows/controller-tool-build-fixture.yml",
    "scripts/release-controller-tools.mts",
    "scripts/release-controller-tool-admission.mts",
    "scripts/release-controller-tool-bootstrap.mts",
    "scripts/github-controller-attestation.mts",
    "docs/qualification/application-update-production.controller-tools.yml",
  ]) {
    const plan = make([file]);
    assert.ok(plan.areas.includes("release-security"), file);
    assert.ok(
      baselineContractTests(plan).includes("scripts/release-controller-tools.test.mts"),
      file,
    );
    assert.ok(
      classifyChanges([{ status: "M", path: file }]).nodeTests.has(
        "scripts/release-controller-tools.test.mts",
      ),
      file,
    );
  }
});

void test("baseline execution fixtures retain explicit local/hosted owners and broad fallback", () => {
  const fixture = "scripts/ci-baseline-execution.test.mts";
  for (const file of [
    "scripts/ci-baseline.mts",
    "scripts/ci-baseline.test.mts",
    "scripts/ci-metrics.mts",
    "scripts/ci-metrics.test.mts",
    ".node-version",
  ]) {
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const input = {
        status: variant.startsWith("R") ? "R100" : variant,
        oldPath: variant === "R-new" ? "docs/moved.md" : file,
        newPath: variant === "R-old" ? "docs/moved.md" : file,
        oldMode: variant === "A" ? "000000" : "100644",
        newMode: variant === "D" ? "000000" : "100644",
      };
      const label = JSON.stringify(input);
      const plan = buildValidationPlan({
        changes: [input],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const local = classifyChanges(
        [
          {
            status: input.status,
            path: input.newPath,
            ...(input.oldPath !== input.newPath ? { previousPath: input.oldPath } : {}),
          },
        ],
        { fileExists: () => false },
      );
      assert.ok(local.nodeTests.has(fixture), "local: " + label);
      assert.equal(
        baselineContractTests(plan, { fileExists: () => false }).filter((file) => file === fixture)
          .length,
        1,
        "hosted: " + label,
      );
    }
  }
  assert.ok(baselineContractTests(make(["unknown/input.bin"])).includes(fixture));
  const firstPush = discoverCiPlan(
    {
      eventName: "push",
      baseSha: "0".repeat(40),
      headSha: "b".repeat(40),
      checkoutSha: "b".repeat(40),
      fastValidationEnabled: true,
      proseOnlyEnabled: true,
    },
    () => assert.fail("first push needs no historical Git reads"),
  );
  assert.ok(baselineContractTests(firstPush).includes(fixture));
  for (const file of [
    "crates/portcove-core/catalog/catalog.json",
    "apps/desktop/src/App.tsx",
    "crates/portcove-core/src/source_report.rs",
    "docs/README.md",
  ]) {
    const selected = baselineContractTests(make([file]));
    assert.equal(selected.includes(fixture), false, file);
    for (const mandatory of [
      "scripts/validation-plan.test.mts",
      "scripts/select-ci-plan.test.mts",
      "scripts/ci-result-gate.test.mts",
      "scripts/ci-baseline.test.mts",
    ])
      assert.ok(selected.includes(mandatory), file + ": " + mandatory);
  }
});

void test("fixture environments retain outer labels without inheriting the metrics sink", () => {
  const original = { GITHUB_RUN_ID: "outer-run", PORTCOVE_CI_METRICS_DIR: "outer-sink" };
  const isolated = baselineTestEnvironment(original);
  assert.notEqual(isolated, original);
  assert.deepEqual(original, { GITHUB_RUN_ID: "outer-run", PORTCOVE_CI_METRICS_DIR: "outer-sink" });
  assert.deepEqual(isolated, { GITHUB_RUN_ID: "outer-run" });
});

void test("coordinator helper and family owners provision their actual Desktop dependency", () => {
  for (const file of [
    "scripts/fixtures/coordinator-state-fixtures.mts",
    "scripts/release-coordinator-state.test.mts",
    "scripts/release-coordinator-recovery.test.mts",
    "scripts/release-coordinator-remote.test.mts",
    "scripts/release-coordinator-checkpoint-evidence.test.mts",
    "scripts/release-coordinator-capacity-effects.test.mts",
    "scripts/release-coordinator-metadata.test.mts",
    "scripts/release-coordinator-signing-exchange.test.mts",
    "scripts/release-coordinator-owned-executor.test.mts",
  ]) {
    for (const variant of ["M", "A", "D", "R-old", "R-new"]) {
      const plan = buildValidationPlan({
        changes: [
          {
            status: variant.startsWith("R") ? "R100" : variant,
            oldPath: variant === "R-new" ? "docs/moved.md" : file,
            newPath: variant === "R-old" ? "docs/moved.md" : file,
            oldMode: variant === "A" ? "000000" : "100644",
            newMode: variant === "D" ? "000000" : "100644",
          },
        ],
        eventName: "pull_request",
        base: "a".repeat(40),
        mergeBase: "a".repeat(40),
        head: "b".repeat(40),
        checkout: "b".repeat(40),
      });
      const label = file + ":" + variant;
      assert.ok(
        baselineContractTests(plan, { fileExists: () => false }).includes(
          "scripts/release-coordinator-state.test.mts",
        ),
        label,
      );
      assert.equal(baselineRequiresDesktopDependencies(plan), true, label);
    }
  }
  assert.equal(baselineRequiresDesktopDependencies(make(["docs/README.md"])), false);
});
