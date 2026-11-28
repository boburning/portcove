import type { SpawnSyncReturns } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import { createInstallFixture } from "./desktop-install-fixture.mts";
const root = fileURLToPath(new URL("../../..", import.meta.url));

void describe("owned Windows probe fixture", { timeout: 240_000 }, () => {
  // Cold hosted Windows compilation exceeded the former 30-second setup limit.
  // Keep compiler, hook and suite budgets nested; probe calls retain five seconds.
  let probeOutput: string | undefined;
  let probeTool: string | undefined;
  beforeAll(
    async () => {
      if (process.platform !== "win32") return;
      probeOutput = await mkdtemp(path.join(tmpdir(), "portcove-probe-compiler-"));
      probeTool = path.join(probeOutput, "probe.exe");
      const compiled = spawnCommand(
        "rustc",
        [
          "--edition=2024",
          "--crate-name",
          "portcove_probe_mode_contract",
          path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
          "-o",
          probeTool,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 120_000 },
      );
      assert.equal(compiled.error, undefined);
      assert.equal(compiled.status, 0, compiled.stderr);
    },
    { timeout: 150_000 },
  );
  afterAll(
    async () => {
      if (probeOutput) await rm(probeOutput, { recursive: true, force: true });
    },
    { timeout: 30_000 },
  );

  void test(
    "Windows acquisition fixture waits for the marker in its assigned library",
    {
      timeout: 30_000,
      skip:
        process.platform !== "win32" &&
        "platform: win32; requires the compiled Windows probe fixture; route: ci.yml/windows_storage (native helper contracts)",
    },
    async () => {
      const output = await mkdtemp(path.join(tmpdir(), "portcove-acquisition-probe-"));
      const tool = probeTool;
      assert.ok(tool);
      try {
        const fixture = await createInstallFixture({
          root,
          output,
          acquisitionJourney: true,
          preparationTool: tool,
        });
        try {
          const marker = fixture.acquisitionWaitPath;
          assert.ok(marker);
          const library = path.join(output, "library");
          assert.equal(marker, path.join(library, "acquisition-game-release.signal"));
          await mkdir(library);
          await writeFile(path.join(output, path.basename(marker)), "outside the assigned library");
          const args = fixture.refreshPort.launch_arguments;
          assert.deepEqual(args, [
            "--game",
            "--wait-for-acquisition-release",
            "--owned-wait-seconds",
            "180",
          ]);
          const observeRelease = () =>
            spawnCommand(tool, args.slice(0, -1).concat("1"), {
              cwd: output,
              env: { ...process.env, PORTCOVE_LIBRARY: library },
              encoding: "utf8",
              windowsHide: true,
              timeout: 5_000,
            });
          const unreleased = observeRelease();
          assert.equal(unreleased.error, undefined);
          assert.equal(unreleased.status, 8, unreleased.stderr);
          await writeFile(marker, "release owned game");
          const released = observeRelease();
          assert.equal(released.error, undefined);
          assert.equal(released.status, 0, released.stderr);
          assert.match(released.stdout, /owned game launched/u);
        } finally {
          await fixture.close();
        }
      } finally {
        await rm(output, { recursive: true, force: true });
      }
    },
  );

  void test(
    "Windows owned probe explicit mode works in empty isolated cwd and preserves the legacy mode route",
    {
      timeout: 30_000,
      skip:
        process.platform !== "win32" &&
        "platform: win32; requires the compiled Windows probe fixture; route: ci.yml/windows_storage (native helper contracts)",
    },
    async () => {
      const output = await mkdtemp(path.join(tmpdir(), "portcove-probe-mode-"));
      try {
        const tool = probeTool;
        assert.ok(tool);
        for (const [name, args, legacy, succeeds, marker] of [
          ["explicit", ["--owned-fixture-mode", "success"], null, true, true],
          ["default", [], null, true, false],
          ["legacy", [], "success", true, true],
          ["missing-marker", ["--owned-fixture-mode", "missing-marker"], null, true, false],
          ["failure", ["--owned-fixture-mode", "failure"], null, false, true],
          ["missing-mode", ["--owned-fixture-mode"], null, false, false],
          ["unsupported", ["--owned-fixture-mode", "invented"], null, false, false],
          [
            "duplicate",
            ["--owned-fixture-mode", "success", "--owned-fixture-mode", "success"],
            null,
            false,
            false,
          ],
        ] satisfies readonly (readonly [
          string,
          readonly string[],
          string | null,
          boolean,
          boolean,
        ])[]) {
          const cwd = path.join(output, name);
          await mkdir(cwd);
          if (legacy) await writeFile(path.join(cwd, "owned-setup-mode"), legacy);
          const result: SpawnSyncReturns<string> = spawnCommand(
            tool,
            ["--owned-preparation", ...args],
            {
              cwd,
              env: { ...process.env, SHIP_HOME: cwd },
              encoding: "utf8",
              windowsHide: true,
              timeout: 5_000,
            },
          );
          assert.equal(result.error, undefined, name);
          assert.equal(result.status === 0, succeeds, `${name}: ${result.stderr}`);
          if (marker)
            assert.equal(
              await readFile(path.join(cwd, "data/out/jak1/iso/0COMMON.TXT"), "utf8"),
              "owned validated output",
            );
          else
            await assert.rejects(readFile(path.join(cwd, "data/out/jak1/iso/0COMMON.TXT")), {
              code: "ENOENT",
            });
        }
      } finally {
        await rm(output, { recursive: true, force: true });
      }
    },
  );
});
