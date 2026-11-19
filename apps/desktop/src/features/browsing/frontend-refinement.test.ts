import { expect, it } from "vite-plus/test";
import {
  installedLaunchStatus,
  portDefinition,
  confirmedSourceAssessment,
} from "../../test-fixtures";
import type { GameUpdateAcquisition } from "../../types";
import { filterPorts } from "../../view-model";
import {
  browsePortPresentation,
  browseStatusSummary,
  gameFilesPresentation,
} from "../port-actions/browse-presentation";

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
          acquiring: "Downloading update",
          verifying: "Checking downloaded update",
          acquired: "Update downloaded, not installed",
          attention_required: "Downloaded update needs attention",
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

it("presents an installed optional game source as optional, and a mandatory one as before", () => {
  const optional = {
    ...port,
    source_profile: "optional-disc",
    bios_source_profile: null,
    optional_game_source: true,
    presentation: {
      installation_method: "portable-package" as const,
      saves_and_settings: "external-user-owned" as const,
      source_requirements: [],
    },
  };
  const mandatory = { ...optional, optional_game_source: false };
  const installed = (
    source: "unregistered" | "current" | "changed" | "unreadable",
    blockers: ("missing_source" | "changed_source" | "unreadable_source")[] = [],
  ) =>
    installedLaunchStatus({
      launchable: blockers.length === 0,
      pending_setup: false,
      blockers,
      source,
      source_assessment: {
        ...confirmedSourceAssessment(),
        health: source === "current" ? "current" : source,
      },
    });
  // Installed, optional, nothing registered: the optional copy wins; the card does not ask
  // for files to be checked while Play and Install are allowed.
  expect(gameFilesPresentation(optional, installed("unregistered")).title).toBe(
    "Game files are optional",
  );
  expect(gameFilesPresentation(optional, undefined).title).toBe("Game files are optional");
  // The replacement is stated before the player chooses an image; mandatory ports never say it.
  expect(gameFilesPresentation(optional, undefined).description).toContain(
    "does not keep files you added to it by hand",
  );
  expect(gameFilesPresentation(mandatory, undefined).description).not.toContain("by hand");
  // Installed, optional, registered and changed or unreadable: Play continues, so this is a
  // notice about the saved image rather than a review of the inputs.
  expect(gameFilesPresentation(optional, installed("changed")).title).toBe(
    "Saved disc image changed",
  );
  expect(gameFilesPresentation(optional, installed("unreadable")).title).toBe(
    "Saved disc image changed",
  );
  // A mandatory source in the same state still needs checking.
  expect(gameFilesPresentation(mandatory, installed("changed")).title).toBe("Files need checking");
  // Installed, optional, registered and current: connected, as for any source.
  expect(gameFilesPresentation(optional, installed("current")).title).toBe("Files connected");
  // Installed, mandatory, nothing registered: unchanged.
  expect(gameFilesPresentation(mandatory, installed("unregistered")).title).toBe(
    "Files need checking",
  );
  expect(
    gameFilesPresentation(mandatory, installed("unregistered", ["missing_source"])).title,
  ).toBe("Setup needed");
  expect(gameFilesPresentation(mandatory, undefined).title).not.toBe("Game files are optional");
});

it("does not turn legacy file blockers or saved paths into a connected/no-input claim", () => {
  const noDeclaredInputs = {
    ...port,
    source_profile: null,
    bios_source_profile: null,
    presentation: {
      installation_method: "portable-package" as const,
      saves_and_settings: "portcove-managed" as const,
      source_requirements: [],
    },
  };
  expect(gameFilesPresentation(noDeclaredInputs, undefined).title).toBe(
    "No files to add in Portcove",
  );
  expect(gameFilesPresentation({ ...noDeclaredInputs, presentation: null }, undefined).title).toBe(
    "Requirements not available",
  );
  for (const blocker of [
    "changed_source",
    "unreadable_bios",
    "incompatible_source",
    "changed_bios",
  ] as const) {
    const status = {
      ...healthy,
      readiness: { launchable: false, pending_setup: false, blockers: [blocker] },
    };
    expect(gameFilesPresentation(noDeclaredInputs, status).title).toBe("Files need checking");
  }
  expect(
    gameFilesPresentation(port, {
      ...healthy,
      readiness: { launchable: false, pending_setup: false, blockers: ["missing_source"] },
    }).title,
  ).toBe("Setup needed");
  expect(
    gameFilesPresentation(port, {
      ...healthy,
      readiness: { launchable: false, pending_setup: false, blockers: [], source: "current" },
    }).title,
  ).toBe("Files need checking");
  expect(gameFilesPresentation(port, healthy).title).toBe("Files connected");
  const unadmitted = {
    ...confirmedSourceAssessment(),
    admission: { ...confirmedSourceAssessment().admission, state: "not_evaluated" as const },
  };
  expect(
    gameFilesPresentation(port, {
      ...healthy,
      readiness: { ...healthy.readiness!, source_assessment: unadmitted },
    }).title,
  ).toBe("Files need checking");
});
