import { describe, expect, it } from "vite-plus/test";
import { portDefinition, portStatus } from "../../test-fixtures";
import type {
  CatalogMediaAsset,
  OriginalGameIdentity,
  PendingSetupRecord,
  PortListing,
  PortStatus,
} from "../../types";
import { filterPorts } from "../../view-model";
import { catalogEntries, usesSelfServiceDetail } from "./catalog-entry";
import { evaluateCatalogQuery } from "./catalog-query";
import { gameGroupId, originalSystems } from "./original-game";

const listing: PortListing = {
  id: "new-project",
  name: "New Project",
  summary: "An upstream port without a managed definition.",
  project_url: "https://example.com/project",
  original_game_title: "Original Game",
  platforms: ["windows-x86-64", "linux-x86-64"],
  availability: "packages",
};
const directory = { format_version: 1, listings: [listing] };
const original: OriginalGameIdentity = {
  format_version: 1,
  id: "reviewed-original",
  evidence_urls: ["https://example.com/original"],
  source_editions: [
    {
      id: "reviewed-edition",
      title: "Reviewed original edition",
      system: "nintendo-64",
      evidence_urls: ["https://example.com/original/edition"],
    },
  ],
};
const screenshot: CatalogMediaAsset = {
  id: "original-scene",
  role: "screenshot",
  subject: {
    kind: "original",
    game_id: original.id,
    source_edition_id: original.source_editions[0]!.id,
  },
  caption: "Synthetic original scene",
  url: `https://raw.githubusercontent.com/example/fixture/${"a".repeat(40)}/scene.png`,
  sha256: "a".repeat(64),
  width: 1,
  height: 1,
  attribution: "Synthetic test fixture",
  source_url: "https://example.com/original/scene",
  license: "CC0-1.0",
  rights_url: "https://example.com/original/rights",
};
const enrichedListing: PortListing = {
  ...listing,
  original_game: original,
  media: [{ ...screenshot, id: "original-header", role: "header" }, screenshot],
  manual_setup: {
    help_url: "https://example.com/new-setup",
    steps: [{ title: "Listing setup", instruction: "Listing-only setup instructions." }],
    warnings: [],
  },
};

function enrichedEntry(definition: ReturnType<typeof portDefinition>) {
  return catalogEntries(
    { schema_version: 1, ports: [definition], source_profiles: [] },
    { format_version: 3, listings: [enrichedListing] },
    [],
    [],
  )[0]!;
}

describe("lightweight catalog entries", () => {
  it("keeps every identity searchable without manufacturing an integration", () => {
    const entries = catalogEntries(undefined, directory, [], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.release).toBeUndefined();
    expect(entries[0]?.definition).toBeUndefined();
    expect(entries[0]?.source_profile).toBeUndefined();
    expect(filterPorts(entries, new Map(), "catalog", "all", "Original Game")).toEqual(entries);
    expect(filterPorts(entries, new Map(), "catalog", "all", "new-project")).toEqual(entries);
    expect(filterPorts(entries, new Map(), "library", "all", "")).toEqual([]);
  });

  it("merges by stable identity without relaxing or replacing the strict definition", () => {
    const definition = { ...portDefinition(), id: listing.id };
    const entries = catalogEntries(
      { schema_version: 1, ports: [definition], source_profiles: [] },
      directory,
      [],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.definition).toBe(definition);
    expect(entries[0]?.release).toBe(definition.release);
    expect(entries[0]?.listing).toBe(listing);
  });

  it("enriches an old strict display with reviewed identity and media without changing its operational owner", () => {
    const presentation = {
      installation_method: "portable-package" as const,
      source_requirements: [],
      saves_and_settings: "portcove-managed" as const,
      original_game_title: "Strict display title",
      manual_preparation: "Keep the strict preparation instructions.",
    };
    const definition = { ...portDefinition(), id: listing.id, presentation };
    const entry = enrichedEntry(definition);
    expect(entry.presentation).toEqual({
      ...presentation,
      original_game: original,
      media: enrichedListing.media,
    });
    expect(entry.definition).toBe(definition);
    expect(entry.definition?.presentation).toBe(presentation);
    expect(definition.presentation).not.toHaveProperty("original_game");
    expect(definition.presentation).not.toHaveProperty("media");
    expect(entry.release).toBe(definition.release);
    expect(entry.source_profile).toBe(definition.source_profile);
    expect(entry.presentation?.manual_setup).toBeUndefined();
    expect(gameGroupId(entry)).toBe(`game:${original.id}`);
    expect(originalSystems(entry)).toEqual(["nintendo-64"]);
  });

  it.each([undefined, null])(
    "adds only descriptive fields when the strict presentation is %s",
    (presentation) => {
      const definition = { ...portDefinition(), id: listing.id };
      if (presentation === null) definition.presentation = null;
      else delete definition.presentation;
      const entry = enrichedEntry(definition);
      expect(entry.presentation).toEqual({
        original_game: original,
        media: enrichedListing.media,
      });
      expect(entry.definition).toBe(definition);
      expect(entry.definition?.presentation).toBe(presentation);
      expect(entry.presentation?.installation_method).toBeUndefined();
      expect(entry.presentation?.manual_setup).toBeUndefined();
    },
  );

  it.each([
    { label: "empty", media: [] },
    { label: "authored", media: [screenshot] },
  ])("preserves explicit strict media ($label)", ({ media }) => {
    const presentation = {
      installation_method: "portable-package" as const,
      source_requirements: [],
      saves_and_settings: "portcove-managed" as const,
      original_game: original,
      media,
    };
    const entry = enrichedEntry({ ...portDefinition(), id: listing.id, presentation });
    expect(entry.presentation).toBe(presentation);
    expect(entry.presentation?.media).toBe(media);
  });

  it.each(["different-game", "different-edition"])(
    "does not inherit original-release media for a %s correction in the strict identity",
    (correction) => {
      const corrected = {
        ...original,
        ...(correction === "different-game" ? { id: "corrected-original" } : {}),
        source_editions: original.source_editions.map((edition) => ({
          ...edition,
          ...(correction === "different-edition" ? { id: "corrected-edition" } : {}),
        })),
      };
      const portImage: CatalogMediaAsset = {
        ...screenshot,
        id: "port-scene",
        subject: { kind: "port", port_id: listing.id },
      };
      const definition = {
        ...portDefinition(),
        id: listing.id,
        presentation: {
          installation_method: "portable-package" as const,
          source_requirements: [],
          saves_and_settings: "portcove-managed" as const,
          original_game: corrected,
        },
      };
      const entry = catalogEntries(
        { schema_version: 1, ports: [definition], source_profiles: [] },
        {
          format_version: 3,
          listings: [{ ...enrichedListing, media: [...enrichedListing.media!, portImage] }],
        },
        [],
        [],
      )[0]!;
      expect(entry.presentation?.original_game).toBe(corrected);
      expect(entry.presentation?.media).toEqual([portImage]);
      expect(entry.definition).toBe(definition);
    },
  );

  it("keeps a saved download discoverable after its listing leaves the current catalog", () => {
    const pending: PendingSetupRecord = {
      id: "download-1",
      port_id: listing.id,
      listing,
      path: "/home/player/Games/new-project",
      state: "attention-required",
      downloaded_at: "2026-10-22T12:00:00Z",
      archive_sha256: "a".repeat(64),
      artifact: {
        release_id: 1,
        asset_id: 2,
        release_tag: "v1",
        name: "game.zip",
        size: 1024,
        release_url: "https://example.com/v1",
        download_url: "https://example.com/game.zip",
        can_extract: true,
        sha256: null,
      },
      reason: "Download was interrupted.",
    };
    const entries = catalogEntries(undefined, { format_version: 1, listings: [] }, [], [pending]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.listing).toBe(listing);
    expect(entries[0]?.definition).toBeUndefined();
    expect(filterPorts(entries, new Map(), "library", "all", "")).toEqual(entries);
    expect(filterPorts(entries, new Map(), "library", "ready", "")).toEqual([]);
    expect(filterPorts(entries, new Map(), "catalog", "all", "Original Game")).toEqual(entries);
  });

  it("prefers a compatible managed route and preserves a held route's explanation", () => {
    const definition = { ...portDefinition(), id: listing.id };
    const status = { ...portStatus(), port_id: listing.id };
    const entry = catalogEntries(
      { schema_version: 1, ports: [definition], source_profiles: [] },
      directory,
      [{ port_id: listing.id, status, actions: [{ action: "attach-existing", allowed: true }] }],
      [],
    )[0]!;
    expect(
      usesSelfServiceDetail(entry, {
        ...status,
        port_actions: [{ action: "install", availability: "waiting", reason: "review_required" }],
      }),
    ).toBe(false);
    expect(
      usesSelfServiceDetail(entry, {
        ...status,
        port_actions: [
          { action: "install", availability: "not_offered", reason: "unsupported_platform" },
        ],
      }),
    ).toBe(true);
    expect(
      usesSelfServiceDetail(entry, {
        ...status,
        port_actions: [
          { action: "install", availability: "held", reason: "definition_ineligible" },
        ],
      }),
    ).toBe(false);
    const accepted = {
      ...entry,
      definition: {
        ...definition,
        release: { ...definition.release, provider: "user-prepared" as const },
      },
    };
    expect(
      usesSelfServiceDetail(accepted, {
        ...status,
        port_actions: [
          { action: "install", availability: "not_offered", reason: "route_not_offered" },
        ],
      }),
    ).toBe(false);
  });

  it("shows unknown-platform projects by default and discloses unknown filtered facts", () => {
    const entries = catalogEntries(
      undefined,
      { ...directory, listings: [{ ...listing, platforms: [] }] },
      [],
      [],
    );
    expect(evaluateCatalogQuery(entries, { version: 1 }).ports).toEqual(entries);
    const filtered = evaluateCatalogQuery(entries, { version: 1, platforms: ["linux-x86-64"] });
    expect(filtered.state).toBe("matched");
    expect(filtered.ports).toEqual([]);
    expect(filtered.unavailablePortIds).toEqual([listing.id]);
    expect(filtered.counts.platforms["linux-x86-64"]).toBe(0);
    expect(filtered.unknownCounts?.platforms["linux-x86-64"]).toBe(1);
  });

  it("does not let unknown listing channels disable integrated results", () => {
    const definition = { ...portDefinition(), id: "managed", channels: ["stable" as const] };
    const entries = catalogEntries(
      { schema_version: 1, ports: [definition], source_profiles: [] },
      directory,
      [],
      [],
    );
    const filtered = evaluateCatalogQuery(entries, { version: 1, channels: ["stable"] });
    expect(filtered.state).toBe("matched");
    expect(filtered.ports.map(({ id }) => id)).toEqual(["managed"]);
    expect(filtered.unavailablePortIds).toEqual([listing.id]);
  });

  it("uses the observed external platform for combined membership filters", () => {
    const status: PortStatus = {
      ...portStatus(),
      port_id: listing.id,
      external_runtime: {
        id: "selected",
        port_id: listing.id,
        platform: "linux-x86-64",
        path: "/home/player/game",
        executable: "/home/player/game/run",
        user_selected: { arguments: [] },
        archive_sha256: "",
        immutable_tree_sha256: "",
        version: "user-managed",
        registered_at: 1,
      },
    };
    const entries = catalogEntries(
      undefined,
      directory,
      [{ port_id: listing.id, status, actions: [] }],
      [],
    );
    const context = { library: { id: "/library", statuses: new Map([[listing.id, status]]) } };
    expect(
      evaluateCatalogQuery(
        entries,
        { version: 1, platforms: ["linux-x86-64"], membership: ["in-library"] },
        context,
      ).ports,
    ).toEqual(entries);
    expect(
      evaluateCatalogQuery(
        entries,
        { version: 1, platforms: ["windows-x86-64"], membership: ["in-library"] },
        context,
      ).ports,
    ).toEqual([]);
    expect(filterPorts(entries, context.library.statuses, "library", "all", "")).toEqual(entries);
  });
});
