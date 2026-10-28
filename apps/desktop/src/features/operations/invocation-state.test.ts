import { expect, it } from "vite-plus/test";
import {
  pendingInvocationConflict,
  targetInvocationContext,
  type InvocationContext,
  type InvocationRecord,
} from "./invocation-state";

const port = { kind: "port", id: "game", label: "Game" } as const;
const acquisition: InvocationContext = {
  ...targetInvocationContext("Download archive", port, 7),
  operation: "acquire_game_update",
};
const launch: InvocationContext = {
  ...targetInvocationContext("Launch", port, 7),
  operation: "launch",
};
function conflict(left: InvocationContext, right: InvocationContext) {
  const pending: InvocationRecord = { id: 1, name: "owned API", context: left, phase: "pending" };
  return pendingInvocationConflict(new Map([[1, pending]]), right);
}

it("allows the permanently immutable acquisition API and launch in either order", () => {
  expect(conflict(acquisition, launch)).toBeUndefined();
  expect(conflict(launch, acquisition)).toBeUndefined();
  expect(conflict(acquisition, acquisition)).toBeDefined();
  expect(conflict(launch, launch)).toBeDefined();
});

it("keeps other file work and library/application maintenance exclusive", () => {
  for (const action of [
    "Prepare",
    "Apply",
    "Verify",
    "Restore",
    "Discard archive",
    "Downloading",
  ]) {
    const mutation = targetInvocationContext(action, port, 7);
    expect(conflict(acquisition, mutation)).toBeDefined();
    expect(conflict(mutation, launch)).toBeDefined();
  }
  for (const exclusionScope of ["library", "application"] as const) {
    expect(conflict({ ...acquisition, exclusionScope }, launch)).toBeDefined();
    expect(conflict(acquisition, { ...launch, exclusionScope })).toBeDefined();
  }
  expect(
    conflict(
      { ...acquisition, target: { ...port, kind: "source" } },
      { ...launch, target: { ...port, kind: "source" } },
    ),
  ).toBeDefined();
  expect(conflict(acquisition, { ...launch, libraryGeneration: 8 })).toBeUndefined();
});
