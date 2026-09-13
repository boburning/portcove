import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildDesktopVerifyPlan, parseDesktopVerifyArgs } from "./desktop-verify.mjs";
import { resolveDesktopSelection } from "./desktop-scenarios.mjs";

test("desktop verify parser defaults to a smoke-compatible cycle configuration", () => {
  const parsed = parseDesktopVerifyArgs([]);
  assert.equal(parsed.profile, undefined);
  assert.deepEqual(parsed.scenarios, []);
  assert.equal(parsed.restartCycles, 1);
  assert.equal(parsed.reloadCycles, 0);
});

test("desktop verify parser accepts a repeated exact series", () => {
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

test("desktop verify parser rejects invalid cycles and JSON execution", () => {
  assert.throws(() => parseDesktopVerifyArgs(["--restart-cycles", "0"]), /1\.\.10/);
  assert.throws(() => parseDesktopVerifyArgs(["--reload-cycles", "26"]), /0\.\.25/);
  assert.throws(() => parseDesktopVerifyArgs(["--json"]), /only with/);
});

test("focused plans omit owned binaries while lifecycle plans include them", () => {
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
  assert.equal(focused.harness_deadline_ms, 180_000);

  const lifecycle = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ scenarios: ["native-reviewed-existing-install-copy"] }),
  });
  assert.ok(lifecycle.paths.cli);
  assert.ok(lifecycle.phases.includes("owned-probe-build"));
  assert.deepEqual(lifecycle.setup_scenarios, ["native-preparation-review-and-play"]);
  assert.equal(lifecycle.harness_deadline_ms, 180_000);

  const full = buildDesktopVerifyPlan({
    ...common,
    selection: resolveDesktopSelection({ profile: "full" }),
  });
  assert.equal(full.harness_deadline_ms, 600_000);
});

test("the native build script preserves identical generated inputs for Cargo reuse", async () => {
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
