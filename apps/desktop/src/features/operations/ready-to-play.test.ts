import { describe, expect, it } from "vite-plus/test";
import { installedLaunchStatus, portDefinition } from "../../test-fixtures";
import { portReadiness } from "../../view-model";
import type { PortStatus } from "../../types";
import type { InvocationRecord } from "./invocation-state";
import { readyToPlayAfter } from "./ready-to-play";

const port = portDefinition();
const record = (
  name = "prepare game data",
  outcome: InvocationRecord["outcome"] = "succeeded",
): InvocationRecord => ({
  id: 1,
  name,
  phase: "settled",
  outcome,
  context: {
    action: "Finish setup",
    target: { kind: "port", id: port.id, label: "Sample" },
    libraryGeneration: 1,
    exclusionScope: "target",
  },
});
const ready = installedLaunchStatus({ launchable: true, blockers: [], pending_setup: false });

describe("readyToPlayAfter", () => {
  it("hands back a game whose current readiness is ready after setup or install", () => {
    expect(portReadiness(ready)).toBe("ready");
    expect(readyToPlayAfter(record(), ready, port)).toBe(true);
    expect(readyToPlayAfter(record("install"), ready, port)).toBe(true);
  });

  it("follows Core's launch assessment even when readiness says launchable", () => {
    const blocked: PortStatus = {
      ...ready,
      port_actions: [{ action: "launch", availability: "held", reason: "definition_ineligible" }],
    };
    expect(portReadiness(blocked)).toBe("blocked");
    expect(readyToPlayAfter(record(), blocked, port)).toBe(false);
  });

  it.each([
    ["remaining setup", { launchable: true, blockers: [], pending_setup: true }],
    ["not launchable", { launchable: false, blockers: [], pending_setup: false }],
  ] as const)("does not claim ready with %s", (_name, readiness) => {
    expect(
      readyToPlayAfter(record(), installedLaunchStatus({ ...readiness, blockers: [] }), port),
    ).toBe(false);
  });

  it("does not claim ready for unknown readiness, other actions, failures or other targets", () => {
    expect(readyToPlayAfter(record(), installedLaunchStatus(), port)).toBe(false);
    expect(readyToPlayAfter(record(), undefined, port)).toBe(false);
    expect(readyToPlayAfter(record(), ready, undefined)).toBe(false);
    expect(readyToPlayAfter(record("back up data"), ready, port)).toBe(false);
    expect(readyToPlayAfter(record("install", "failed"), ready, port)).toBe(false);
    expect(
      readyToPlayAfter(
        {
          ...record(),
          context: { ...record().context, target: { kind: "library", id: "x", label: "x" } },
        },
        ready,
        port,
      ),
    ).toBe(false);
  });

  it("leaves external runtimes to the game page and its launch warnings", () => {
    const external = {
      ...ready,
      external_runtime: { id: "external", port_id: port.id, path: "C:/Game" },
    } as unknown as PortStatus;
    expect(readyToPlayAfter(record(), external, port)).toBe(false);
  });
});
