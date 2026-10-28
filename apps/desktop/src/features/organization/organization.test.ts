import { expect, it } from "vite-plus/test";
import type { LibraryOrganization } from "../../types";
import { organizedPorts, savedGameId, savedForPort } from "./OrganizationControls";
import { portDefinition } from "../../test-fixtures";
import { setupConfirmed, updateNoticeHidden } from "./organization";

it("does not hide a rebuilt release or mistake an unknown candidate for the skipped artifact", () => {
  const choice = {
    paused: false,
    skipped_release: { version: "v1", artifact_sha256: "a".repeat(64) },
  };
  expect(updateNoticeHidden(choice, choice.skipped_release)).toBe(true);
  expect(updateNoticeHidden(choice, { version: "v1", artifact_sha256: "b".repeat(64) })).toBe(
    false,
  );
  expect(updateNoticeHidden(choice, undefined)).toBe(false);
  expect(updateNoticeHidden({ ...choice, paused: true }, undefined)).toBe(true);
});

it("keeps setup attestations specific to port, installation identity and ownership", () => {
  const snapshot: LibraryOrganization = {
    revision: 1,
    collections: {},
    hidden_port_ids: [],
    saved_game_ids: [],
    update_notices: {},
    setup_confirmations: [
      { port_id: "port", context: { kind: "external", installation_id: "first" } },
    ],
  };
  expect(setupConfirmed(snapshot, "port", { kind: "external", installation_id: "first" })).toBe(
    true,
  );
  expect(setupConfirmed(snapshot, "port", { kind: "managed", installation_id: "first" })).toBe(
    false,
  );
  expect(setupConfirmed(snapshot, "port", { kind: "external", installation_id: "second" })).toBe(
    false,
  );
  expect(
    setupConfirmed(snapshot, "other-port", { kind: "external", installation_id: "first" }),
  ).toBe(false);
  expect(setupConfirmed(undefined, "port", { kind: "external", installation_id: "first" })).toBe(
    false,
  );
});

it("Library hiding never removes a port from the searchable Discover union", () => {
  const port = portDefinition();
  const organization = {
    snapshot: {
      revision: 1,
      collections: {},
      hidden_port_ids: [port.id],
      saved_game_ids: [savedGameId(port)],
      update_notices: {},
      setup_confirmations: [],
    },
    busy: false,
    failure: undefined,
    commit: async () => true,
    refresh: async () => true,
  };
  expect(organizedPorts([port], organization, "all")).toEqual([]);
  expect(organizedPorts([port], organization, "hidden")).toEqual([port]);
  expect(organizedPorts([port], organization, "all", true)).toEqual([port]);
  expect(organizedPorts([port], organization, "saved", true)).toEqual([port]);
  expect(organizedPorts([port], undefined, "saved", true)).toEqual([]);
});

it("preserves port-scoped Saved choices when reviewed game identity is added", () => {
  const original = portDefinition();
  const enriched = {
    ...original,
    presentation: {
      ...original.presentation!,
      original_game: {
        format_version: 1,
        id: "known-game",
        evidence_urls: ["https://example.org/identity"],
        source_editions: [],
      },
    },
  };
  const organization = {
    snapshot: {
      revision: 1,
      collections: {},
      hidden_port_ids: [],
      saved_game_ids: [`port-${original.id}`],
      update_notices: {},
      setup_confirmations: [],
    },
    busy: false,
    failure: undefined,
    commit: async () => true,
    refresh: async () => true,
  };
  expect(savedForPort(organization, enriched)).toBe(true);
  expect(organizedPorts([enriched], organization, "saved", true)).toEqual([enriched]);
  expect(organization.snapshot.saved_game_ids).toEqual([`port-${original.id}`]);
});
