import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  cargoPhaseArguments,
  executeCargoPhase,
  lifecyclePaths,
  runCargoPhase,
} from "./lifecycle-check.mts";

void test("internal Cargo execution requires a matching inherited lease before starting its timer", async () => {
  let executed = false;
  let released = 0;
  const environment = { PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "owned" };
  await executeCargoPhase("cli-build", undefined, {
    environment,
    acquire: async (_metadata, options) => {
      assert.equal(options.inheritedToken, "owned");
      assert.equal(executed, false);
      return {
        inherited: true,
        release: async () => {
          released++;
        },
      };
    },
    execute: async (command, args) => {
      assert.equal(command, "cargo");
      assert.ok(args.includes("--locked"));
      executed = true;
    },
  });
  assert.equal(released, 1);
  executed = false;
  await assert.rejects(
    executeCargoPhase("cli-build", undefined, {
      environment,
      acquire: async () => {
        throw new Error("Inherited token mismatch");
      },
      execute: async () => {
        executed = true;
      },
    }),
    /mismatch/,
  );
  assert.equal(executed, false);
});

void test("actual private phase refuses a forged inherited token without running Cargo", () => {
  const result = spawnSync(
    process.execPath,
    ["integrations/playnite/lifecycle-check.mts", "--cargo-phase", "cli-build"],
    {
      env: { ...process.env, PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "forged-retro-regression-token" },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Inherited|ENOENT/);
  assert.doesNotMatch(result.stdout, /Finished.*dev.*profile/);
});

void test("lifecycle executable and fixture temp follow the resolved storage layout", () => {
  for (const target of [path.resolve("target"), path.resolve("external SSD 雪", "cargo")]) {
    const temporary = path.resolve("selected temp 雪");
    assert.deepEqual(lifecyclePaths({ target_directory: target, temporary_directory: temporary }), {
      cli: path.join(target, "debug", "portcove.exe"),
      temporary,
    });
  }
});

void test("every finite Cargo phase delegates admission and closure to the existing guard", async () => {
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
        Object.hasOwn(options, "timeout"),
        false,
        "lock waiting is not under the Cargo execution timer",
      );
      return 0;
    });
    assert.equal(called, 1);
  }
});

void test("unknown phases and failed/unknown closure cannot continue qualification", async () => {
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
