import { expect, it } from "vite-plus/test";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import { groupCatalog } from "./original-game";
import { resolveGameChoice } from "./game-choice";

const first = {
  ...portDefinition(),
  id: "first",
  presentation: {
    original_game: { format_version: 1, id: "game", evidence_urls: [], source_editions: [] },
  },
};
const second = { ...first, id: "second" };
const group = groupCatalog([first, second])[0]!;
const installed = (id: string): PortStatus => ({
  ...portStatus(),
  port_id: id,
  active: {
    id: `installation-${id}`,
    port_id: id,
    version: "1",
    path: `/owned/${id}`,
    channel: "stable",
    installed_at: 1,
    verified: true,
    staged: false,
    artifact: { asset_name: "owned.zip", sha256: "a".repeat(64), size: 1 },
    manifest_sha256: "b".repeat(64),
    runtime: null,
    selected_executable: "owned.exe",
  },
});

it("keeps explicit implementation choice independent of availability and input ordering", () => {
  const result = resolveGameChoice(group, new Map(), { game: second.id });
  expect(result).toEqual({ port: second, reason: "explicit", preferredPortId: "second" });
  expect(
    resolveGameChoice(groupCatalog([second, first])[0]!, new Map(), { game: "second" }),
  ).toEqual(result);
});

it("never substitutes the sole remaining implementation for a stale or filtered choice", () => {
  expect(resolveGameChoice(group, new Map(), { game: "missing" })).toEqual({
    reason: "stale",
    preferredPortId: "missing",
  });
  const filtered = groupCatalog([first, second], [first])[0]!;
  expect(resolveGameChoice(filtered, new Map(), { game: "second" })).toEqual({
    reason: "filtered",
    preferredPortId: "second",
  });
});

it("single and unresolved entries remain direct without an optional preference read", () => {
  const standalone = { ...portDefinition(), id: "unresolved" };
  expect(resolveGameChoice(groupCatalog([standalone])[0]!, new Map(), undefined)).toEqual({
    port: standalone,
    reason: "single",
  });
  expect(resolveGameChoice(group, new Map(), undefined)).toEqual({ reason: "unavailable" });
  expect(resolveGameChoice(group, new Map(), {})).toEqual({ reason: "ambiguous" });
});

it("keeps an unambiguous installed offline target when optional choices cannot be read", () => {
  const statuses = new Map([[first.id, installed(first.id)]]);
  expect(resolveGameChoice(group, statuses, undefined)).toEqual({
    port: first,
    reason: "installed",
  });
  statuses.set(second.id, installed(second.id));
  expect(resolveGameChoice(group, statuses, {})).toEqual({ reason: "ambiguous" });
  expect(resolveGameChoice(group, statuses, undefined)).toEqual({ reason: "unavailable" });
  expect(resolveGameChoice(group, statuses, { game: "missing" }).reason).toBe("stale");
});

it("does not treat retained/staged bytes as normal installed targets or union filter matches", () => {
  const status = installed(first.id);
  status.previous = status.active;
  status.staged = status.active;
  status.active = null;
  expect(resolveGameChoice(group, new Map([[first.id, status]]), {})).toEqual({
    reason: "ambiguous",
  });
  const filtered = groupCatalog([first, second], [second])[0]!;
  expect(resolveGameChoice(filtered, new Map([[first.id, installed(first.id)]]), {})).toEqual({
    reason: "filtered",
  });
  expect(filtered.matchingPorts.map((port) => port.id)).toEqual(["second"]);
});
