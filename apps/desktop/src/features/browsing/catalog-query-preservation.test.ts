import { expect, it } from "vite-plus/test";
import { portDefinition } from "../../test-fixtures";
import type { CatalogBrowsingContext, CatalogBrowsingSnapshot } from "../../types";
import { catalogEntries, type CatalogEntry } from "./catalog-entry";
import { evaluateCatalogQuery, type CatalogQueryContext } from "./catalog-query";

// Original-output controls established before splitting the evaluator. These
// deliberately distinguish source declarations, observed routes and unknowns.
const port = { ...portDefinition(), id: "integrated", platforms: ["windows-x86-64" as const] };
const known: CatalogBrowsingContext = {
  context_id: "a".repeat(64),
  port_id: port.id,
  route: "managed_install",
  platform: "linux-x86-64",
  channel: "stable",
  installation_method: "portable-package",
  member_context: false,
  port_member: false,
  installation_id: null,
  definition_sha256: "b".repeat(64),
  instance_sha256: null,
  release_version: "new",
  artifact_sha256: "c".repeat(64),
};
function context(facts = [known]): CatalogQueryContext {
  return {
    library: { id: "selected", statuses: new Map() },
    browsing: {
      schema_version: 1,
      library: { id: "opaque", root: "selected" },
      host_platform: "linux-x86-64",
      retained_metadata_complete: true,
      workspace_binding_sha256: "d".repeat(64),
      contexts: facts,
    },
  };
}

it("uses valid coherent observations even for zero or one active group", () => {
  const empty = evaluateCatalogQuery([port], { version: 1 }, context());
  expect(empty.ports).toEqual([port]);
  expect(empty.matchingContexts.get(port.id)).toEqual([known]);
  expect(empty.matchingContexts.get(port.id)?.[0]).toBe(known);
  expect(empty.counts.platforms["linux-x86-64"]).toBe(1);
  expect(empty.counts.platforms["windows-x86-64"]).toBe(0);
  expect(
    evaluateCatalogQuery([port], { version: 1, platforms: ["windows-x86-64"] }, context()).ports,
  ).toEqual([]);
});

for (const [name, mutate] of [
  ["schema", (snapshot: CatalogBrowsingSnapshot) => ({ ...snapshot, schema_version: 2 })],
  [
    "binding",
    (snapshot: CatalogBrowsingSnapshot) => ({ ...snapshot, workspace_binding_sha256: "invalid" }),
  ],
  [
    "duplicate-context",
    (snapshot: CatalogBrowsingSnapshot) => ({
      ...snapshot,
      contexts: [...snapshot.contexts, { ...known }],
    }),
  ],
] as const) {
  it(`falls back for an optional invalid ${name} snapshot but refuses a required context join`, () => {
    const original = context();
    const invalid = { ...original, browsing: mutate(original.browsing!) };
    const single = evaluateCatalogQuery(
      [port],
      { version: 1, platforms: ["windows-x86-64"] },
      invalid,
    );
    expect(single.state).toBe("matched");
    expect(single.ports).toEqual([port]);
    expect(single.matchingContexts.size).toBe(0);
    const joined = evaluateCatalogQuery(
      [port],
      { version: 1, platforms: ["windows-x86-64"], membership: ["not-in-library"] },
      invalid,
    );
    expect(joined.state).toBe("unavailable");
    expect(joined.ports).toEqual([]);
    expect(joined.counts.platforms["windows-x86-64"]).toBeNull();
  });
}

it("lets a known matching context win over an unknown alternative without treating it as matched", () => {
  const unknown = { ...known, context_id: "e".repeat(64), platform: null };
  const result = evaluateCatalogQuery(
    [port],
    { version: 1, platforms: ["linux-x86-64"] },
    context([unknown, known]),
  );
  expect(result.state).toBe("matched");
  expect(result.ports).toEqual([port]);
  expect(result.matchingContexts.get(port.id)).toEqual([known]);
  expect(result.counts.platforms["linux-x86-64"]).toBe(1);
  expect(result.counts.platforms["windows-x86-64"]).toBeNull();
});

it("lets a false group win over an unknown group while keeping unknown facet counts", () => {
  const unknown = { ...known, platform: null, channel: "beta" as const };
  const result = evaluateCatalogQuery(
    [port],
    { version: 1, platforms: ["linux-x86-64"], channels: ["stable"] },
    context([unknown]),
  );
  expect(result.state).toBe("matched");
  expect(result.ports).toEqual([]);
  expect(result.matchingContexts.get(port.id)).toEqual([]);
  expect(result.counts.platforms["linux-x86-64"]).toBe(0);
  expect(result.counts.channels.beta).toBeNull();
});

it("preserves first integration identity and interleaved input order with conflicting duplicates", () => {
  const first = { ...port, name: "first" };
  const last = { ...port, name: "last", platforms: ["linux-x86-64" as const] };
  const other = { ...port, id: "other", name: "other" };
  const listing: CatalogEntry = {
    id: "listing",
    name: "Listing",
    summary: "Declaration only",
    platforms: ["windows-x86-64"],
    listing: {
      id: "listing",
      name: "Listing",
      summary: "Declaration only",
      project_url: "https://example.invalid",
      platforms: ["windows-x86-64"],
      availability: "packages",
    },
  };
  const inputs = [listing, first, other, last];
  const all = evaluateCatalogQuery(inputs, { version: 1 });
  expect(all.ports).toEqual([listing, first, other]);
  expect(all.ports[1]).toBe(first);
  const filtered = evaluateCatalogQuery(inputs, { version: 1, platforms: ["linux-x86-64"] });
  expect(filtered.ports).toEqual([]);
  expect(filtered.counts.platforms["linux-x86-64"]).toBe(0);
});

it("keeps pending setup membership and finish-setup visible with unknown platform facts", () => {
  const listing = {
    id: "pending",
    name: "Pending",
    summary: "Saved download",
    project_url: "https://example.invalid",
    platforms: ["windows-x86-64" as const],
    availability: "packages" as const,
  };
  const entries = catalogEntries(
    undefined,
    { format_version: 1, listings: [] },
    [],
    [
      {
        id: "download",
        port_id: listing.id,
        listing,
        path: "/owned/pending",
        state: "attention-required",
        downloaded_at: "2026-10-25T00:00:00Z",
        archive_sha256: "a".repeat(64),
        reason: "Interrupted",
        artifact: {
          release_id: 1,
          asset_id: 2,
          release_tag: "v1",
          name: "game.zip",
          size: 1,
          release_url: "https://example.invalid/release",
          download_url: "https://example.invalid/game.zip",
          can_extract: true,
          sha256: null,
        },
      },
    ],
  );
  const local = { library: { id: "selected", statuses: new Map() } };
  const member = evaluateCatalogQuery(
    entries,
    { version: 1, membership: ["in-library"], attention: ["finish-setup"] },
    local,
  );
  expect(member.ports).toEqual(entries);
  expect(member.counts.membership["in-library"]).toBe(1);
  const platform = evaluateCatalogQuery(
    entries,
    { version: 1, platforms: ["windows-x86-64"] },
    local,
  );
  expect(platform.ports).toEqual([]);
  expect(platform.unavailablePortIds).toEqual([listing.id]);
  expect(platform.unknownCounts?.platforms["windows-x86-64"]).toBe(1);
});
