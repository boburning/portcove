import { describe, expect, it } from "vite-plus/test";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { PendingSetupRecord, PortListing, PortStatus } from "../../types";
import { filterPorts } from "../../view-model";
import { catalogEntries, usesSelfServiceDetail } from "./catalog-entry";
import { evaluateCatalogQuery } from "./catalog-query";

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
