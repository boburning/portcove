import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildDesktopVerifyPlan,
  desktopBuildEnvironment,
  parseDesktopVerifyArgs,
  desktopVerificationOutputResources,
  checkpointTestNames,
  requireCheckpointTestExecution,
} from "./desktop-verify.mts";
import { resolveDesktopSelection } from "./desktop-scenarios.mts";
import { frontendOutputResource } from "./resource-capacity.mts";

void test("native admission includes target output and deduplicates physical aliases", () => {
  const workspace = path.resolve("work/retro-admission");
  const target = path.resolve("work/retro-cargo");
  assert.deepEqual(desktopVerificationOutputResources({ workspace, target_directory: target }), [
    frontendOutputResource(workspace),
    frontendOutputResource(target),
  ]);
  assert.deepEqual(
    desktopVerificationOutputResources({
      workspace,
      target_directory: path.join(workspace, "child", ".."),
    }),
    [frontendOutputResource(workspace)],
  );
  assert.throws(() => desktopVerificationOutputResources({ workspace }), /resolved Rust target/);
});

void test("checkpoint feature feedback requires nonempty complete execution, not just exit zero", () => {
  const first = "qualification_checkpoint::tests::one";
  const second = "qualification_checkpoint::tests::two";
  const listing = `${first}: test\r\n${second}: test\r\n\r\n2 tests, 0 benchmarks\r\n`;
  const names = checkpointTestNames(listing);
  assert.deepEqual(names, [first, second]);
  for (const invalid of [
    "0 tests, 0 benchmarks",
    `${first}: test\n2 tests, 0 benchmarks`,
    `${first}: test\n${first}: test\n2 tests, 0 benchmarks`,
  ])
    assert.throws(() => checkpointTestNames(invalid), /inventory/);
  const output = `test ${first} ... ok\ntest ${second} ... ok\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 0.01s\n`;
  requireCheckpointTestExecution(names, output);
  for (const invalid of [
    "",
    output.replace(`test ${second} ... ok\n`, ""),
    output.replace("0 ignored", "1 ignored"),
    output.replace(first, second),
  ])
    assert.throws(
      () => requireCheckpointTestExecution(names, invalid),
      /complete selected inventory/,
    );
});

void test("feature feedback is selected only for existing fixture-feature native builds", () => {
  const common = {
    paths: { output_root: path.resolve("out"), target_directory: path.resolve("target") },
    drivers: null,
    source: { revision: "a".repeat(40), clean: true },
    packages: { ready: false },
  };
  const fixture = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({
      scenarios: ["native-host-publication-recovery"],
      platform: "win32",
    }),
  });
  assert.ok(
    fixture.phases.indexOf("checkpoint-feature-tests") < fixture.phases.indexOf("frontend-build"),
  );
  assert.deepEqual(
    fixture.required_output_resources,
    desktopVerificationOutputResources({
      workspace: fileURLToPath(new URL("../", import.meta.url)),
      target_directory: common.paths.target_directory,
    }),
  );
  const ordinary = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["keyboard-layout"] }),
  });
  assert.ok(!ordinary.phases.includes("checkpoint-feature-tests"));
});

void test("desktop verify parser defaults to a smoke-compatible cycle configuration", () => {
  const parsed = parseDesktopVerifyArgs([]);
  assert.equal(parsed.profile, undefined);
  assert.deepEqual(parsed.scenarios, []);
  assert.equal(parsed.restartCycles, 1);
  assert.equal(parsed.reloadCycles, 0);
});

void test("desktop verify parser accepts a repeated exact series", () => {
  const parsed = parseDesktopVerifyArgs([
    "--scenario",
    "keyboard-layout",
    "--scenario",
    "accessibility",
    "--require-clean",
    "--plan",
    "--json",
  ]);
  assert.deepEqual(parsed.scenarios, ["keyboard-layout", "accessibility"]);
  assert.equal(parsed.requireClean, true);
  assert.equal(parsed.plan, true);
  assert.equal(parsed.json, true);
});

void test("desktop verify parser rejects invalid cycles and JSON execution", () => {
  assert.throws(() => parseDesktopVerifyArgs(["--restart-cycles", "0"]), /1\.\.10/);
  assert.throws(() => parseDesktopVerifyArgs(["--reload-cycles", "26"]), /0\.\.25/);
  assert.throws(() => parseDesktopVerifyArgs(["--json"]), /only with/);
});

void test("only the exact design compatibility scenario selects the fixture build", () => {
  const base = { PORTCOVE_TEMP_DIR: "test" };
  const ordinary = desktopBuildEnvironment(
    base,
    resolveDesktopSelection({ scenarios: ["keyboard-layout"] }),
  );
  assert.equal(ordinary.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE, undefined);
  const compatibility = desktopBuildEnvironment(
    base,
    resolveDesktopSelection({ scenarios: ["native-design-system-compatibility"] }),
  );
  assert.equal(compatibility.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE, "1");
  assert.equal(compatibility.PORTCOVE_TEMP_DIR, "test");
});

void test("focused plans omit owned binaries while lifecycle plans include them", () => {
  const paths = {
    output_root: path.resolve("out"),
    target_directory: path.resolve("target"),
  };
  const common = {
    paths,
    drivers: { driver: "driver", nativeDriver: "native" },
    source: { revision: "a".repeat(40), clean: true },
    packages: { ready: true, selenium: "module" },
  };
  const focused = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["keyboard-layout"] }),
  });
  assert.equal(focused.paths.cli, null);
  assert.ok(!focused.phases.includes("owned-probe-build"));
  assert.ok(!focused.phases.includes("scenario-context-preflight"));
  assert.equal(focused.harness_deadline_ms, 180_000);
  assert.deepEqual(focused.qualification_features, []);

  const install = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["install-progress-cancellation"] }),
  });
  assert.equal(install.paths.cli, null);
  assert.deepEqual(install.qualification_features, ["qualification-fixtures"]);

  const external = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({
      scenarios: ["native-external-runtime-review"],
      platform: "win32",
    }),
  });
  assert.deepEqual(external.qualification_features, ["qualification-fixtures"]);
  assert.equal(external.paths.cli, null);
  assert.ok(!external.phases.includes("owned-probe-build"));
  assert.ok(!external.phases.includes("scenario-context-preflight"));
  assert.equal(external.harness_deadline_ms, 180_000);

  const installRefresh = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["install-commit-refresh-recovery"] }),
  });
  assert.equal(installRefresh.paths.cli, null);
  assert.deepEqual(installRefresh.qualification_features, ["qualification-fixtures"]);

  const lifecycle = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["native-reviewed-existing-install-copy"] }),
  });
  assert.ok(lifecycle.paths.cli);
  assert.ok(
    lifecycle.phases.indexOf("scenario-context-preflight") <
      lifecycle.phases.indexOf("frontend-build"),
  );
  assert.ok(lifecycle.phases.includes("owned-probe-build"));
  assert.deepEqual(lifecycle.setup_scenarios, ["native-preparation-review-and-play"]);
  assert.equal(lifecycle.harness_deadline_ms, 180_000);

  const full = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ profile: "full" }),
  });
  assert.equal(full.harness_deadline_ms, 1_200_000);
});

void test("the native build script preserves identical generated inputs for Cargo reuse", async () => {
  const buildScript = await readFile(
    new URL("../apps/desktop/src-tauri/build.rs", import.meta.url),
    "utf8",
  );
  assert.match(buildScript, /fn write_if_changed/u);
  assert.match(buildScript, /fs::read\(path\)\.ok\(\)\.as_deref\(\) == Some\(contents\)/u);
  assert.match(buildScript, /write_if_changed\(&embedded_root/u);
  assert.match(buildScript, /write_if_changed\(&generated, source\.as_bytes\(\)\)/u);
  assert.doesNotMatch(buildScript, /fs::write\(&embedded_root/u);
  assert.doesNotMatch(buildScript, /fs::write\(generated/u);
});

void test("standalone selected setup routes build catalog-aware CLIs", async () => {
  const common = {
    paths: { output_root: path.resolve("out"), target_directory: path.resolve("target") },
    drivers: { driver: "driver", nativeDriver: "native" },
    source: { revision: "a".repeat(40), clean: true },
    packages: { ready: true, selenium: "module" },
  };
  for (const scenario of [
    "native-saved-folder-selected-setup",
    "native-selected-setup-completion",
  ]) {
    const selected = buildDesktopVerifyPlan({
      ...common,
      selection: resolveDesktopSelection({ scenarios: [scenario], platform: "win32" }),
    });
    assert.deepEqual(selected.cli_features, ["portcove-core/qualification-fixtures"]);
    assert.deepEqual(selected.qualification_features, ["qualification-fixtures"]);
    assert.deepEqual(selected.setup_scenarios, []);
    assert.equal(selected.harness_deadline_ms, 180_000);
    assert.ok(selected.paths.cli);
  }
  const ordinary = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["native-preparation-review-and-play"] }),
  });
  assert.deepEqual(ordinary.cli_features, []);
});
