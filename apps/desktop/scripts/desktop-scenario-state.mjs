// Owned native fixture state shared across scenario orderings.
import assert from "node:assert/strict";
import path from "node:path";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

// Optional native fixtures use their own CLI/library, never the application's adapter.
export function ownedFixtureCommand({ cli, library, output, catalogPath }, spawn = spawnCommand) {
  return (args, selectedLibrary = library) => {
    const result = spawn(
      cli,
      ["--library", selectedLibrary, "--json", "--non-interactive", ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          ...(catalogPath === undefined ? {} : { PORTCOVE_QUALIFICATION_CATALOG: catalogPath }),
          PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    return response.data;
  };
}

export function installedPreservationWitness(command) {
  for (const portId of ["opengoal-jak1", "opengoal-jak2"]) {
    const install = command(["status", portId]).active;
    if (install) return { portId, install };
  }
  assert.fail("an installed owned game is required for preservation proof");
}
