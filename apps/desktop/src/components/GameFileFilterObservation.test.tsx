import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { GameFileQuerySnapshot } from "../types";
import type { GameFileFilterContext } from "../features/browsing/game-file-query-context";
import { GameFileFilterObservation } from "./GameFileFilterObservation";

const projection: GameFileQuerySnapshot["routes"][number] = {
  port_id: "selected",
  route: "external_registration",
  platform: "linux-x86-64",
  channel: "beta",
  state: "files_available",
  reason: "complete_compatible_observation",
  identity: { game_id: "game", variant_id: "variant", representation_id: "representation" },
  contract_id: "contract",
  source_instance_sha256: "a".repeat(64),
  route_definition_sha256: "b".repeat(64),
  route_instance_sha256: null,
};
const context = (item = projection): GameFileFilterContext => ({
  libraryKey: "scope",
  library: { id: "opaque", root: "/private/game-files" },
  selection: { route: item.route, platform: item.platform, channel: item.channel },
  observedAt: 1,
  expiresAt: 301,
  byPort: new Map([[item.port_id, item]]),
});

it("explains the selected catalog observation with its exact route, target, channel and complete set", () => {
  const html = renderToStaticMarkup(
    <GameFileFilterObservation portId="selected" context={context()} />,
  );
  expect(html).toContain("Compatible complete files available");
  expect(html).toContain("Existing installation setup");
  expect(html).toContain("Linux");
  expect(html).toContain("Preview");
  expect(html).toContain("game / variant / representation");
  expect(html).not.toContain("/private/game-files");
  expect(html).not.toContain(projection.source_instance_sha256!);
});

it.each([
  ["files_missing", "no_connected_registration", "No game-file registration"],
  ["needs_checking", "storage_absence_unconfirmed", "files are not confirmed missing"],
  ["no_files_required", "explicit_empty_requirements", "No files to add in Portcove"],
  ["unavailable_context", "route_not_offered", "selected route is not offered"],
] as const)(
  "preserves the Core reason for %s without inventing a complete set",
  (state, reason, text) => {
    const html = renderToStaticMarkup(
      <GameFileFilterObservation
        portId="selected"
        context={context({ ...projection, state, reason })}
      />,
    );
    expect(html).toContain(text);
    expect(html).not.toContain("Complete set:");
    expect(html.includes("The game may still ask for original files.")).toBe(
      state === "no_files_required",
    );
  },
);

it("does not borrow another port's observation or retain an unavailable catalog context", () => {
  expect(
    renderToStaticMarkup(<GameFileFilterObservation portId="other" context={context()} />),
  ).toBe("");
  expect(renderToStaticMarkup(<GameFileFilterObservation portId="selected" />)).toBe("");
});
