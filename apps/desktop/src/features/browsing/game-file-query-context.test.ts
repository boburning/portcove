import { expect, it } from "vitest";
import { portDefinition } from "../../test-fixtures";
import type { GameFileQuerySnapshot } from "../../types";
import { evaluateCatalogQuery } from "./catalog-query";
import { gameFileFilterContext, gameFileFilterRequest } from "./game-file-query-context";

const now = 1000;
const library = { id: "opaque-library", root: "private-root" };
const states = [
  "files_available",
  "files_missing",
  "needs_checking",
  "no_files_required",
  "unavailable_context",
] as const;
const ports = states.map((state, index) => ({
  ...portDefinition(),
  id: state,
  channels: index === 1 ? ["beta" as const] : ["stable" as const],
}));
const request = gameFileFilterRequest(ports, {
  route: "managed_install",
  platform: "windows-x86-64",
  channel: "stable",
})!;
const snapshot = (): GameFileQuerySnapshot => ({
  schema_version: 1,
  library,
  catalog_binding_sha256: "a".repeat(64),
  registration_sha256: "b".repeat(64),
  selection_sha256: "c".repeat(64),
  observed_at: now,
  expires_at: now + 300,
  routes: request.routes.map((route, index) => ({
    ...route,
    state: states[index],
    reason: [
      "complete_compatible_observation",
      "no_connected_registration",
      "storage_absence_unconfirmed",
      "explicit_empty_requirements",
      "observation_unavailable",
    ][index] as GameFileQuerySnapshot["routes"][number]["reason"],
    contract_id: index === 0 ? "contract" : null,
    identity:
      index === 0
        ? { game_id: "game", variant_id: "variant", representation_id: "complete-set" }
        : null,
    source_instance_sha256: index === 0 ? "d".repeat(64) : null,
    route_definition_sha256: index === 4 ? null : "e".repeat(64),
    route_instance_sha256: null,
  })),
});
const context = () => ({
  library: { id: "scope", statuses: new Map() },
  gameFiles: gameFileFilterContext(snapshot(), request, library, "scope", now)!,
});

it("builds one finite complete-catalog request and refuses empty, duplicate and oversized selections", () => {
  expect(request.routes).toHaveLength(5);
  expect(request.limits.max_elapsed_ms).toBe(30000);
  const selection = {
    route: "managed_install" as const,
    platform: "windows-x86-64" as const,
    channel: "stable" as const,
  };
  for (const invalid of [
    [],
    [ports[0], ports[0]],
    Array.from({ length: 257 }, (_, index) => ({ ...ports[0], id: `port-${index}` })),
    [{ ...ports[0], id: "é".repeat(65) }],
  ])
    expect(gameFileFilterRequest(invalid, selection)).toBeUndefined();
});
it("rejects incomplete, extra, duplicate, stale, foreign-library and route-inconsistent observations", () => {
  const baseline = snapshot();
  expect(gameFileFilterContext(baseline, request, library, "scope", now)).toBeDefined();
  for (const invalid of [
    { ...baseline, routes: baseline.routes.slice(1) },
    { ...baseline, routes: [...baseline.routes, baseline.routes[0]] },
    {
      ...baseline,
      routes: baseline.routes.map((route, index) => (index === 1 ? baseline.routes[0] : route)),
    },
    { ...baseline, observed_at: now - 301, expires_at: now - 1 },
    { ...baseline, library: { ...library, id: "different" } },
    {
      ...baseline,
      routes: baseline.routes.map((route, index) =>
        index === 1 ? { ...route, platform: "linux-x86-64" as const } : route,
      ),
    },
  ])
    expect(gameFileFilterContext(invalid, request, library, "scope", now)).toBeUndefined();
});
it("offers every Core state, OR within game files, AND across groups, and distinct exact counts", () => {
  const all = evaluateCatalogQuery([...ports, ports[0]], { version: 1 }, context());
  expect(all.counts.gameFiles).toEqual(Object.fromEntries(states.map((state) => [state, 1])));
  for (const state of states)
    expect(
      evaluateCatalogQuery(ports, { version: 1, gameFiles: [state] }, context()).ports.map(
        (port) => port.id,
      ),
    ).toEqual([state]);
  expect(
    evaluateCatalogQuery(
      ports,
      { version: 1, gameFiles: ["files_available", "files_missing"], channels: ["beta"] },
      context(),
    ).ports.map((port) => port.id),
  ).toEqual(["files_missing"]);
  expect(
    evaluateCatalogQuery(ports, { version: 1, channels: ["beta"] }, context()).counts.gameFiles
      .files_available,
  ).toBe(0);
  expect(
    evaluateCatalogQuery(ports, { version: 1, gameFiles: ["files_missing"] }, context()).ports.map(
      (port) => port.id,
    ),
  ).not.toContain("needs_checking");
});
it("retains selected choices as unavailable when context or exact catalog coverage is absent", () => {
  const query = { version: 1, gameFiles: ["files_available"] };
  for (const local of [
    {},
    { ...context(), library: { id: "different", statuses: new Map() } },
    { ...context(), gameFiles: { ...context().gameFiles, byPort: new Map() } },
  ]) {
    const result = evaluateCatalogQuery(ports, query, local);
    expect(result.state).toBe("unavailable");
    expect(result.query).toBe(query);
    expect(result.counts.gameFiles.files_available).toBeNull();
  }
  const partial = evaluateCatalogQuery(
    [...ports, { ...ports[0], id: "unchecked" }],
    { version: 1 },
    context(),
  );
  expect(partial.ports).toHaveLength(6);
  expect(partial.counts.gameFiles.files_missing).toBeNull();
});
