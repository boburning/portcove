import { describe, expect, it } from "vitest";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { CatalogBrowsingContext, CatalogBrowsingSnapshot, PortDefinition } from "../../types";
import { evaluateCatalogQuery, type CatalogQueryContext } from "./catalog-query";

const port: PortDefinition = {
  ...portDefinition(),
  id: "mixed",
  platforms: ["windows-x86-64", "linux-x86-64"],
};
const base: CatalogBrowsingContext = {
  context_id: "a".repeat(64),
  port_id: port.id,
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
const installed: CatalogBrowsingContext = {
  ...base,
  context_id: "d".repeat(64),
  route: "managed_launch",
  platform: "windows-x86-64",
  channel: "stable",
  member_context: true,
  installation_id: "retained",
  instance_sha256: "e".repeat(64),
  installation_method: "referenced-disc",
  release_version: "old",
};
function context(contexts = [base, installed]): CatalogQueryContext {
  const browsing: CatalogBrowsingSnapshot = {
    schema_version: 1,
    library: { id: "opaque", root: "selected" },
    host_platform: "linux-x86-64",
    retained_metadata_complete: true,
    workspace_binding_sha256: "f".repeat(64),
    contexts,
  };
  return {
    library: {
      id: "selected",
      statuses: new Map([[port.id, { ...portStatus(), port_id: port.id }]]),
    },
    browsing,
    devicePlatform: browsing.host_platform,
  };
}
// One port with a Linux setup and a different Windows installed build.
describe("coherent Core browsing contexts", () => {
  it("joins game files only to the exact route, retained definition and instance", () => {
    const facts = context();
    facts.gameFiles = {
      libraryKey: "selected",
      library: facts.browsing!.library,
      selection: { route: "managed_launch", platform: "windows-x86-64", channel: "stable" },
      observedAt: 1,
      expiresAt: 100,
      byPort: new Map([
        [
          port.id,
          {
            port_id: port.id,
            route: "managed_launch",
            platform: "windows-x86-64",
            channel: "stable",
            state: "files_available",
            reason: "complete_compatible_observation",
            contract_id: "reviewed",
            identity: { game_id: "game", variant_id: "variant", representation_id: "complete" },
            source_instance_sha256: "1".repeat(64),
            route_definition_sha256: installed.definition_sha256,
            route_instance_sha256: installed.instance_sha256,
          },
        ],
      ]),
    };
    const query = { version: 1, gameFiles: ["files_available"], membership: ["in-library"] };
    expect(evaluateCatalogQuery([port], query, facts).matchingContexts.get(port.id)).toEqual([
      installed,
    ]);
    const observation = facts.gameFiles.byPort.get(port.id)!;
    facts.gameFiles = {
      ...facts.gameFiles,
      byPort: new Map([[port.id, { ...observation, route_instance_sha256: "2".repeat(64) }]]),
    };
    expect(evaluateCatalogQuery([port], query, facts).state).toBe("unavailable");
    facts.gameFiles = {
      ...facts.gameFiles,
      byPort: new Map([[port.id, { ...observation, route_definition_sha256: "3".repeat(64) }]]),
    };
    expect(evaluateCatalogQuery([port], query, facts).counts.gameFiles.files_available).toBeNull();
  });
  it("does not join Linux setup with Windows membership or retained setup method", () => {
    const query = { version: 1, membership: ["in-library"], platforms: ["linux-x86-64"] };
    const result = evaluateCatalogQuery([port], query, context());
    expect(result.state).toBe("matched");
    expect(result.ports).toEqual([]);
    expect(result.counts.platforms["windows-x86-64"]).toBe(1);
    expect(result.counts.platforms["linux-x86-64"]).toBe(0);
    expect(
      evaluateCatalogQuery(
        [port],
        { version: 1, platforms: ["linux-x86-64"], installationMethods: ["referenced-disc"] },
        context(),
      ).ports,
    ).toEqual([]);
  });
  it("keeps occupied setup and whole-port absence distinct", () => {
    expect(
      evaluateCatalogQuery(
        [port],
        { version: 1, platforms: ["this-device"], channels: ["beta"] },
        context(),
      ).matchingContexts.get(port.id),
    ).toEqual([base]);
    expect(
      evaluateCatalogQuery(
        [port],
        { version: 1, membership: ["not-in-library"], platforms: ["linux-x86-64"] },
        context(),
      ).ports,
    ).toEqual([]);
  });
  it("does not guess a historical platform or publish a false zero", () => {
    const result = evaluateCatalogQuery(
      [port],
      { version: 1, membership: ["in-library"], platforms: ["linux-x86-64"] },
      context([base, { ...installed, platform: null }]),
    );
    expect(result.state).toBe("unavailable");
    expect(result.counts.platforms["linux-x86-64"]).toBeNull();
    expect(result.matchingContexts.size).toBe(0);
  });
  it("counts one port for multiple matching contexts and preserves exact detail identities", () => {
    const other = { ...installed, context_id: "1".repeat(64), platform: "linux-x86-64" as const };
    const result = evaluateCatalogQuery(
      [port, port],
      { version: 1, membership: ["in-library"] },
      context([base, installed, other]),
    );
    expect(result.ports).toEqual([port]);
    expect(result.counts.membership["in-library"]).toBe(1);
    expect(result.matchingContexts.get(port.id)?.map((fact) => fact.context_id)).toEqual([
      installed.context_id,
      other.context_id,
    ]);
  });
  it("rejects cross-library and incomplete context coverage", () => {
    const facts = context();
    facts.library = { id: "different", statuses: new Map() };
    expect(
      evaluateCatalogQuery(
        [port],
        { version: 1, membership: ["in-library"], channels: ["stable"] },
        facts,
      ).state,
    ).toBe("unavailable");
    expect(
      evaluateCatalogQuery(
        [port],
        { version: 1, membership: ["in-library"], channels: ["stable"] },
        context([]),
      ).state,
    ).toBe("unavailable");
  });
});
