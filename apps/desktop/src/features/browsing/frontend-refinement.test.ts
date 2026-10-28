import { expect, it } from "vite-plus/test";
import {
  installedLaunchStatus,
  portDefinition,
  confirmedSourceAssessment,
} from "../../test-fixtures";
import type { GameUpdateAcquisition } from "../../types";
import { filterPorts } from "../../view-model";
import { browsePortPresentation, browseStatusSummary } from "../port-actions/browse-presentation";

const port = portDefinition();
const healthy = installedLaunchStatus({
  launchable: true,
  pending_setup: false,
  blockers: [],
  source: "current",
  source_assessment: confirmedSourceAssessment(),
});
const acquisition: GameUpdateAcquisition = {
  id: "archive",
  port_id: port.id,
  platform: "windows-x86-64",
  phase: "acquiring",
  created_at: 1,
  updated_at: 1,
  release: {
    version: "2",
    channel: "stable",
    published_at: null,
    asset: {
      name: "game.zip",
      sha256: "a".repeat(64),
      size: 1,
      url: "https://example.org/game.zip",
    },
  },
};

it.each(["library", "catalog"] as const)(
  "uses one summary without hiding concurrent blockers in %s",
  (view) => {
    const ready = browsePortPresentation(port, healthy, view);
    expect(ready.state.tone).toBe("ready");
    expect(browseStatusSummary(ready.state, healthy, false)).toEqual({
      showReadiness: true,
      update: undefined,
    });
    expect(browseStatusSummary(ready.state, healthy, true)).toEqual({
      showReadiness: false,
      update: "Update available at last check",
    });
    for (const phase of ["acquiring", "verifying", "acquired", "attention_required"] as const) {
      const status = { ...healthy, acquisition: { ...acquisition, phase }, staged: healthy.active };
      expect(browseStatusSummary(ready.state, status, true)).toEqual({
        showReadiness: false,
        update: {
          acquiring: "Downloading archive",
          verifying: "Verifying archive",
          acquired: "Archive downloaded",
          attention_required: "Archive needs attention",
        }[phase],
      });
    }
    const blocked = {
      ...healthy,
      acquisition,
      readiness: {
        launchable: false,
        pending_setup: false,
        blockers: ["missing_source", "missing_runtime"] as const,
      },
    };
    const observation = browsePortPresentation(
      port,
      {
        ...blocked,
        readiness: { ...blocked.readiness, blockers: [...blocked.readiness.blockers] },
      },
      view,
    );
    expect(observation.state.label).toBe("Game files missing");
    expect(observation.concurrentBlockers).toContain("A required runtime component is missing.");
    expect(browseStatusSummary(observation.state, healthy, true).showReadiness).toBe(true);
    const unknown = browsePortPresentation(port, { ...healthy, readiness: null }, view);
    expect(unknown.state.tone).not.toBe("ready");
    expect(browseStatusSummary(unknown.state, healthy, true).showReadiness).toBe(true);
  },
);

it("sorts matching ports by full title and real launch history with deterministic ties", () => {
  const ports = ["Zulu", "Alpha", "Alpha", "Never played"].map((name, index) => ({
    ...port,
    id: String(index),
    name,
  }));
  const statuses = new Map(
    ports.map((entry, index) => [
      entry.id,
      { ...healthy, port_id: entry.id, last_launched_at: [10, 20, 20, null][index]! },
    ]),
  );
  const ids = (sort: "name" | "name-desc" | "recent", view: "library" | "catalog") =>
    filterPorts(ports, statuses, view, "all", "", sort).map((port) => port.id);
  for (const view of ["library", "catalog"] as const) {
    expect(ids("name", view)).toEqual(["1", "2", "3", "0"]);
    expect(ids("name-desc", view)).toEqual(["0", "3", "1", "2"]);
  }
  expect(ids("recent", "library")).toEqual(["1", "2", "0", "3"]);
  expect(
    filterPorts(ports, statuses, "library", "all", "alpha", "recent").map((port) => port.id),
  ).toEqual(["1", "2"]);
});

it("retains concurrent input blockers when invalid installation takes precedence", () => {
  const observation = browsePortPresentation(
    port,
    {
      ...healthy,
      readiness: {
        launchable: false,
        pending_setup: false,
        blockers: ["invalid_installation", "missing_source"],
      },
    },
    "library",
  );
  expect(observation.concurrentBlockers).toContain("Required game files are missing.");
});
