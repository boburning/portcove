// Owned native fixture state shared across scenario orderings.
import assert from "node:assert/strict";

export function installedPreservationWitness(command) {
  for (const portId of ["opengoal-jak1", "opengoal-jak2"]) {
    const install = command(["status", portId]).active;
    if (install) return { portId, install };
  }
  assert.fail("an installed owned game is required for preservation proof");
}
