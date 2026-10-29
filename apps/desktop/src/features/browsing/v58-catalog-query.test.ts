import { expect, it } from "vite-plus/test";
import catalog from "../../../../../crates/portcove-core/catalog/catalog.json";
import { currentCatalogPort } from "../../catalog-test-fixtures";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { CatalogBrowsingContext, CatalogBrowsingSnapshot, PortDefinition } from "../../types";
import { filterPorts } from "../../view-model";
import {
  evaluateCatalogQuery,
  sourceSystemOptions,
  filterOptionsFor,
  type CatalogQueryContext,
} from "./catalog-query";
import { groupCatalog } from "./original-game";
import { catalogEntries } from "./catalog-entry";

function port(
  id: string,
  gameId: string,
  systems: (string | undefined)[],
  overrides: Partial<PortDefinition> = {},
): PortDefinition {
  const base = portDefinition();
  return {
    ...base,
    id,
    name: id,
    ...overrides,
    presentation: {
      installation_method: "portable-package",
      source_requirements: [],
      saves_and_settings: "portcove-managed",
      original_game: {
        format_version: 1,
        id: gameId,
        evidence_urls: ["https://example.org/source"],
        source_editions: systems.map((system, index) => ({
          id: `edition-${index}`,
          title: `Edition ${index}`,
          evidence_urls: ["https://example.org/source"],
          ...(system ? { system } : {}),
        })),
      },
    },
  };
}
const ids = (result: ReturnType<typeof evaluateCatalogQuery>) =>
  result.ports.map((entry) => entry.id);

it.each([
  ["beetle-recomp", ["stable", "rolling"]],
  ["re-blue", ["stable", "rolling"]],
  ["g-diffuser", ["stable", "beta"]],
  ["mega-man-x6-recompiled", ["stable", "beta"]],
] as const)(
  "matches every production offered channel for %s without changing durable IDs",
  (id, offered) => {
    const entry = currentCatalogPort(id);
    expect(entry.channels).toEqual(offered);
    for (const channel of entry.channels) {
      const result = evaluateCatalogQuery([entry], { version: 1, channels: [channel] });
      expect(result.state).toBe("matched");
      expect(ids(result)).toEqual([id]);
      expect(result.counts.channels[channel]).toBe(1);
    }
    expect(evaluateCatalogQuery([entry], { version: 1, channels: ["preview"] }).state).toBe(
      "unresolved",
    );
  },
);

it("checks all current multi-channel definitions rather than only the four reference examples", () => {
  const multiple = catalog.ports.filter((entry) => entry.channels.length > 1);
  expect(multiple.length).toBeGreaterThanOrEqual(4);
  for (const authored of multiple) {
    const entry = currentCatalogPort(authored.id);
    for (const channel of entry.channels)
      expect(ids(evaluateCatalogQuery([entry], { version: 1, channels: [channel] }))).toEqual([
        entry.id,
      ]);
  }
});

it("combines source system, target OS and release on one port while preserving OR inside a facet", () => {
  const windows = port("windows", "shared-game", ["nintendo-64"], {
    platforms: ["windows-x86-64"],
    channels: ["stable"],
  });
  const linux = port("linux", "shared-game", ["playstation"], {
    platforms: ["linux-x86-64"],
    channels: ["beta"],
  });
  const entries = [windows, linux];
  expect(
    ids(
      evaluateCatalogQuery(entries, {
        version: 1,
        originalSystems: ["nintendo-64"],
        platforms: ["linux-x86-64"],
      }),
    ),
  ).toEqual([]);
  expect(
    ids(
      evaluateCatalogQuery(entries, {
        version: 1,
        originalSystems: ["nintendo-64", "playstation"],
        platforms: ["linux-x86-64"],
        channels: ["stable", "beta"],
      }),
    ),
  ).toEqual(["linux"]);
});

it("does not cross a Linux Preview setup with a different Windows Stable installation context", () => {
  const entry = port("mixed", "game", ["nintendo-64"], {
    platforms: ["windows-x86-64", "linux-x86-64"],
    channels: ["stable", "beta"],
  });
  const base: CatalogBrowsingContext = {
    context_id: "a".repeat(64),
    port_id: entry.id,
    route: "managed_install",
    platform: "linux-x86-64",
    channel: "beta",
    installation_method: "portable-package",
    member_context: false,
    port_member: true,
    installation_id: null,
    definition_sha256: "b".repeat(64),
    instance_sha256: null,
    release_version: "new",
    artifact_sha256: "c".repeat(64),
  };
  const browsing: CatalogBrowsingSnapshot = {
    schema_version: 1,
    library: { id: "opaque", root: "selected" },
    host_platform: "linux-x86-64",
    retained_metadata_complete: true,
    workspace_binding_sha256: "d".repeat(64),
    contexts: [
      base,
      {
        ...base,
        context_id: "e".repeat(64),
        route: "managed_launch",
        platform: "windows-x86-64",
        channel: "stable",
        member_context: true,
        installation_id: "active",
        instance_sha256: "f".repeat(64),
      },
    ],
  };
  const context: CatalogQueryContext = {
    browsing,
    library: {
      id: "selected",
      statuses: new Map([[entry.id, { ...portStatus(), port_id: entry.id }]]),
    },
  };
  const blocked = evaluateCatalogQuery(
    [entry],
    {
      version: 1,
      originalSystems: ["nintendo-64"],
      platforms: ["linux-x86-64"],
      channels: ["stable"],
    },
    context,
  );
  expect(blocked.state).toBe("matched");
  expect(ids(blocked)).toEqual([]);
  const match = evaluateCatalogQuery(
    [entry],
    {
      version: 1,
      originalSystems: ["nintendo-64"],
      platforms: ["linux-x86-64"],
      channels: ["beta"],
    },
    context,
  );
  expect(ids(match)).toEqual([entry.id]);
  expect(match.matchingContexts.get(entry.id)?.map((fact) => fact.context_id)).toEqual([
    base.context_id,
  ]);
});

it("keeps multiple original editions, Not specified and restored system IDs searchable without defaulting to PC", () => {
  const multiple = port("multiple", "game", ["nintendo-64", "nintendo-64dd"]);
  const unknown = port("unknown", "unknown-game", [undefined]);
  const noEditions = port("no-editions", "third-game", []);
  const entries = [multiple, unknown, noEditions];
  expect(
    ids(evaluateCatalogQuery(entries, { version: 1, originalSystems: ["nintendo-64dd"] })),
  ).toEqual(["multiple"]);
  expect(
    ids(evaluateCatalogQuery(entries, { version: 1, originalSystems: ["not-specified"] })),
  ).toEqual(["unknown", "no-editions"]);
  expect(ids(evaluateCatalogQuery(entries, { version: 1, originalSystems: ["pc"] }))).toEqual([]);
  expect(
    sourceSystemOptions(entries, { version: 1, originalSystems: ["future-console"] }),
  ).toContain("future-console");
  expect(
    evaluateCatalogQuery(entries, {
      version: 1,
      originalSystems: ["nintendo-64"],
      membership: ["in-library"],
    }).state,
  ).toBe("unavailable");
  expect(evaluateCatalogQuery(entries, { version: 1, originalSystems: [42] }).state).toBe(
    "unresolved",
  );
});

it("counts descriptive-only systems and newly admitted ports beyond the prototype snapshot", () => {
  const identity = port("authored-source", "new-original-game", ["future-console"]).presentation!
    .original_game!;
  const entries = catalogEntries(
    undefined,
    {
      format_version: 1,
      listings: [
        {
          id: "added-after-v58",
          name: "A newly accepted project",
          summary: "Source-only upstream project",
          project_url: "https://example.org/new-project",
          availability: "source-only",
          platforms: [],
          original_game: identity,
        },
      ],
    },
    [],
    [],
  );
  const result = evaluateCatalogQuery(entries, { version: 1, originalSystems: ["future-console"] });
  expect(result.state).toBe("matched");
  expect(ids(result)).toEqual(["added-after-v58"]);
  expect(result.counts.originalSystems["future-console"]).toBe(1);
  expect(result.ports[0]?.release).toBeUndefined();
  const unknownPlatform = evaluateCatalogQuery(entries, {
    version: 1,
    originalSystems: ["future-console"],
    platforms: ["windows-x86-64"],
  });
  expect(unknownPlatform.ports).toEqual([]);
  expect(unknownPlatform.unavailablePortIds).toEqual(["added-after-v58"]);
});

it("keeps total Multiple ports distinct from filtered matching-port and unique-game counts", () => {
  const first = port("windows-first", "shared", ["nintendo-64"], { platforms: ["windows-x86-64"] });
  const second = port("linux-second", "shared", ["nintendo-64"], { platforms: ["linux-x86-64"] });
  const single = port("linux-single", "single", ["playstation"], { platforms: ["linux-x86-64"] });
  const entries = [first, second, single];
  const result = evaluateCatalogQuery(entries, {
    version: 1,
    portOptions: ["multiple"],
    platforms: ["linux-x86-64"],
  });
  expect(ids(result)).toEqual(["linux-second"]);
  expect(result.counts.portOptions.multiple).toBe(1);
  expect(result.counts.portOptions.single).toBe(1);
  const groups = groupCatalog(entries, result.ports);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.ports).toHaveLength(2);
  expect(groups[0]?.matchingPorts).toHaveLength(1);
  expect(
    filterPorts(
      entries,
      new Map(),
      "catalog",
      { version: 1, portOptions: ["multiple"] },
      "linux-second",
    ).map((entry) => entry.id),
  ).toEqual(["linux-second"]);
});

it("retains total group counts when a caller narrows candidates before facet counts", () => {
  const first = port("first-port", "shared", ["nintendo-64"]);
  const second = port("second-port", "shared", ["nintendo-64"]);
  const result = evaluateCatalogQuery(
    [second],
    { version: 1, portOptions: ["multiple"] },
    { catalogUniverse: [first, second] },
  );
  expect(ids(result)).toEqual(["second-port"]);
  expect(result.counts.portOptions.multiple).toBe(1);
});

it("derives applicable filters in schema order and preserves selected zero-match values", () => {
  const entries = [
    port("windows", "game", [], { platforms: ["windows-x86-64"], channels: ["stable"] }),
  ];
  expect(
    filterOptionsFor("platforms", entries, { version: 1, platforms: ["macos-aarch64"] }),
  ).toEqual(["windows-x86-64", "macos-aarch64", "this-device"]);
  expect(filterOptionsFor("channels", entries, { version: 1, channels: ["beta"] })).toEqual([
    "stable",
    "beta",
  ]);
  expect(filterOptionsFor("installationMethods", entries, { version: 1 })).toEqual([
    "portable-package",
  ]);
  expect(evaluateCatalogQuery(entries, { version: 1, platforms: ["future-os"] }).state).toBe(
    "unresolved",
  );
  const unknown = { ...entries[0]!, platforms: ["future-os"] } as unknown as PortDefinition;
  expect(filterOptionsFor("platforms", [unknown], { version: 1 })).toEqual(["this-device"]);
});

it("keeps filter choices applicable to retained Core contexts after catalog changes", () => {
  const entry = port("changed", "game", [], {
    platforms: ["windows-x86-64"],
    channels: ["stable"],
  });
  const context: CatalogQueryContext = {
    library: { id: "library", statuses: new Map() },
    browsing: {
      schema_version: 1,
      host_platform: "windows-x86-64",
      library: { id: "library", root: "/library" },
      retained_metadata_complete: true,
      workspace_binding_sha256: "a".repeat(64),
      contexts: [
        {
          port_id: "changed",
          context_id: "old",
          platform: "linux-x86-64",
          channel: "beta",
          installation_method: "upstream-setup",
          artifact_sha256: null,
          definition_sha256: null,
          installation_id: "old",
          instance_sha256: null,
          member_context: true,
          port_member: true,
          release_version: "old",
          route: "managed_launch",
        },
      ],
    },
  };
  expect(filterOptionsFor("platforms", [entry], { version: 1 }, context)).toContain("linux-x86-64");
  expect(filterOptionsFor("channels", [entry], { version: 1 }, context)).toContain("beta");
  expect(filterOptionsFor("installationMethods", [entry], { version: 1 }, context)).toContain(
    "upstream-setup",
  );
  expect(
    filterOptionsFor("platforms", [entry], { version: 1 }, { ...context, browsing: undefined }),
  ).toContain("macos-aarch64");
});
