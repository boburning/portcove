import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { cargoPhaseArguments, lifecyclePaths, runCargoPhase } from "./lifecycle-check.mjs";

test("lifecycle executable and fixture temp follow the resolved storage layout", () => {
  for (const target of [path.resolve("target"), path.resolve("external SSD 雪", "cargo")]) {
    const temporary = path.resolve("selected temp 雪");
    assert.deepEqual(lifecyclePaths({ target_directory: target, temporary_directory: temporary }), {
      cli: path.join(target, "debug", "portcove.exe"),
      temporary,
    });
  }
});

test("every finite Cargo phase delegates admission and closure to the existing guard", async () => {
  const environment = {
    PORTCOVE_TEMP_DIR: path.resolve("guard temp"),
    PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "inherited",
    PORTCOVE_QUALIFICATION_DEFINITION_ACTION: "select",
  };
  for (const [phase, action] of [
    ["cli-build", undefined],
    ["definition-state", "select"],
    ["definition-state", "install"],
    ["definition-state", "revoke"],
  ]) {
    let called = 0;
    await runCargoPhase(phase, action, environment, async (args, options) => {
      called++;
      assert.equal(args[0], "--guard-command");
      assert.equal(args[1], process.execPath);
      assert.deepEqual(args.slice(3), [
        "--cargo-phase",
        phase,
        ...(action === undefined ? [] : [action]),
      ]);
      assert.equal(options.environment, environment);
      assert.equal(options.tempRoot, environment.PORTCOVE_TEMP_DIR);
      assert.equal(
        options.timeout,
        undefined,
        "lock waiting is not under the Cargo execution timer",
      );
      return 0;
    });
    assert.equal(called, 1);
  }
});

test("unknown phases and failed/unknown closure cannot continue qualification", async () => {
  let calls = 0;
  const guard = async () => {
    calls++;
    return 1;
  };
  await assert.rejects(runCargoPhase("arbitrary", undefined, {}, guard), /Unknown/);
  assert.equal(calls, 0);
  await assert.rejects(runCargoPhase("cli-build", undefined, {}, guard), /retain.*closure/);
  assert.throws(() => cargoPhaseArguments("definition-state", "cleanup"), /Unknown/);
  assert.throws(() => cargoPhaseArguments("cli-build", "extra"), /Unknown/);
  assert.ok(cargoPhaseArguments("cli-build").includes("--locked"));
  assert.ok(cargoPhaseArguments("definition-state", "select").includes("--exact"));
});
