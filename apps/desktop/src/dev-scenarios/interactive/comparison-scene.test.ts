import { expect, it } from "vite-plus/test";
import { comparisonEntries } from "./comparison-scene";
import { workspace } from "./scenarios";

it("projects the matched scene without merging duplicate games or disguising source image dimensions", () => {
  const { catalog, statuses } = workspace("comparison");
  expect(catalog.ports.map((port) => port.id)).toEqual(comparisonEntries.map((entry) => entry.id));
  expect(new Set(catalog.ports.map((port) => port.id)).size).toBe(12);
  expect(catalog.ports[0]?.presentation?.original_game_title).toBe(
    catalog.ports[1]?.presentation?.original_game_title,
  );
  expect(catalog.ports[0]?.name).not.toBe(catalog.ports[1]?.name);
  expect(statuses.map((status) => status.readiness?.launchable)).toEqual(
    comparisonEntries.map((entry) => entry.state === "ready"),
  );
  for (const entry of comparisonEntries) {
    if (!entry.artwork) continue;
    const bytes = Uint8Array.from(atob(entry.artwork.png), (character) => character.charCodeAt(0));
    const png = new DataView(bytes.buffer);
    expect([png.getUint32(16), png.getUint32(20)]).toEqual([
      entry.artwork.width,
      entry.artwork.height,
    ]);
  }
  expect(
    new Set(
      comparisonEntries.flatMap((entry) =>
        entry.artwork ? [entry.artwork.width / entry.artwork.height] : [],
      ),
    ).size,
  ).toBe(3);
});
