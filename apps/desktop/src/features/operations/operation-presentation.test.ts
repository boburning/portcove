import { expect, it } from "vite-plus/test";
import { portStatus } from "../../test-fixtures";
import { presentPortAction } from "./operation-presentation";
import { targetInvocationContext, type InvocationRecord } from "./invocation-state";

const pending: InvocationRecord = {
  id: 1,
  name: "prepare",
  phase: "pending",
  context: targetInvocationContext("Prepare", { kind: "port", id: "A", label: "Game A" }, 7),
};
const owner = { generation: 7, pending: new Map([[1, pending]]) };
it("uses one local-conflict assessment without rewriting observed readiness", () => {
  const a = presentPortAction(owner, "A", portStatus(), "launch");
  const b = presentPortAction(owner, "B", portStatus(), "launch");
  expect(a.assessment.blocked).toBe(true);
  expect(a.readiness.blocked).toBe(false);
  expect(a.busy).toBe("prepare");
  expect(a.assessment.reason).toContain("Game A");
  expect(b.assessment.blocked).toBe(false);
  expect(b.busy).toBeUndefined();
});
it("retains Core holds regardless of local conflict or another target", () => {
  const status = {
    ...portStatus(),
    port_actions: [
      {
        action: "launch",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ] as const,
  };
  const observed = { ...status, port_actions: [...status.port_actions] };
  const a = presentPortAction(owner, "A", observed, "launch");
  const b = presentPortAction(owner, "B", observed, "launch");
  expect(a.assessment).toEqual(a.readiness);
  expect(b.assessment.blocked).toBe(true);
});
it("excludes every target for known library/application maintenance", () => {
  for (const exclusionScope of ["library", "application"] as const) {
    const maintenance = { ...pending, context: { ...pending.context, exclusionScope } };
    expect(
      presentPortAction(
        { generation: 7, pending: new Map([[1, maintenance]]) },
        "B",
        portStatus(),
        "launch",
      ).busy,
    ).toBe("prepare");
  }
});

it("keeps Core launch holds while allowing the dedicated immutable transfer locally", () => {
  const transfer: InvocationRecord = {
    ...pending,
    name: "acquire_game_update",
    context: { ...pending.context, operation: "acquire_game_update" },
  };
  const transferring = { generation: 7, pending: new Map([[1, transfer]]) };
  expect(presentPortAction(transferring, "A", portStatus(), "launch").assessment.blocked).toBe(
    false,
  );
  expect(presentPortAction(transferring, "A", portStatus(), "install").assessment.blocked).toBe(
    true,
  );
  const held = {
    ...portStatus(),
    port_actions: [
      { action: "launch", availability: "held", reason: "invalid_installation", definition: null },
    ],
  } as const;
  expect(
    presentPortAction(
      transferring,
      "A",
      { ...held, port_actions: [...held.port_actions] },
      "launch",
    ).assessment.blocked,
  ).toBe(true);
});
