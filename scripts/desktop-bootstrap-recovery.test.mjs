import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bootstrapRecoveryEnvironment,
  bootstrapRecoverySelection,
  prepareBootstrapRecoveryFixture,
} from "../apps/desktop/scripts/desktop-bootstrap-recovery-test.mjs";

test("startup recovery refuses unsupported host and mixed setup before launch", () => {
  const selection = {
    selected_scenarios: ["native-startup-library-recovery"],
    setup_scenarios: [],
  };
  assert.equal(bootstrapRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => bootstrapRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    bootstrapRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(() =>
    bootstrapRecoverySelection(
      { ...selection, selected_scenarios: [...selection.selected_scenarios, "empty-library"] },
      "win32",
    ),
  );
});

test("startup fixture child cannot inherit an invocation that masks saved selection", () => {
  const inherited = {
    ...process.env,
    PORTCOVE_LIBRARY: "masked-saved-selection",
    PORTCOVE_PREFERENCES: "owned-preferences",
  };
  const environment = bootstrapRecoveryEnvironment(inherited);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({library:process.env.PORTCOVE_LIBRARY,preferences:process.env.PORTCOVE_PREFERENCES}))",
    ],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { preferences: "owned-preferences" });
  assert.equal(inherited.PORTCOVE_LIBRARY, "masked-saved-selection");
});

test("initial saved target is a regular file and reseeding cannot overwrite a recovered choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareBootstrapRecoveryFixture(output);
  assert.ok((await stat(fixture.invalidRoot)).isFile());
  assert.ok((await stat(fixture.selectedRoot)).isDirectory());
  const before = await readFile(fixture.preferencesBefore);
  assert.equal(JSON.parse(before).library_root, fixture.invalidRoot);
  assert.deepEqual(await readFile(fixture.invalidRoot), await readFile(fixture.invalidBefore));
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareBootstrapRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.preferencesBefore), before);
});
