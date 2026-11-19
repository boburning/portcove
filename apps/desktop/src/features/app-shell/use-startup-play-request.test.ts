import { describe, expect, it } from "vite-plus/test";
import { installedLaunchStatus, portDefinition } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import { startupPlayAction } from "./use-startup-play-request";

describe("startup play requests", () => {
  const port = portDefinition();
  const statuses = (status: PortStatus) => new Map([[port.id, status]]);
  const ready = installedLaunchStatus({ launchable: true, blockers: [], pending_setup: false });

  it("plays a game that can start directly", () => {
    expect(startupPlayAction(port.id, [port], statuses(ready))).toEqual({ kind: "play", port });
  });

  it("opens details when the game needs attention before it can play", () => {
    const blocked = installedLaunchStatus({
      launchable: false,
      blockers: ["missing_source"],
      pending_setup: false,
    });
    expect(startupPlayAction(port.id, [port], statuses(blocked))).toEqual({
      kind: "details",
      port,
    });
    const removed: PortStatus = { ...ready, active: null };
    expect(startupPlayAction(port.id, [port], statuses(removed))?.kind).toBe("details");
    expect(startupPlayAction(port.id, [port], new Map())?.kind).toBe("details");
  });

  it("does nothing for a game this library no longer lists", () => {
    expect(startupPlayAction("retired-port", [port], statuses(ready))).toBeUndefined();
  });
});
