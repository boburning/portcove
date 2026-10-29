import { describe, expect, it } from "vite-plus/test";
import { initialDetailSection, detailWorkSection } from "./detail-sections";

describe("detail opening destination", () => {
  it.each([
    ["updates", true, true, "versions"],
    ["saves", true, true, "saves"],
    ["files", false, true, "files"],
    ["files", true, false, "files"],
    [undefined, true, true, "files"],
    [undefined, true, false, "files"],
    [undefined, false, true, "versions"],
    [undefined, false, false, "overview"],
  ] as const)(
    "maps destination %s / files %s / update %s to %s",
    (destination, needsFiles, hasUpdate, expected) => {
      expect(initialDetailSection({ destination, needsFiles, hasUpdate })).toBe(expected);
    },
  );
});

it.each([
  ["back up data", "saves"],
  ["restore backup", "saves"],
  ["run reviewed game update", "versions"],
  ["acquire_game_update", "versions"],
  ["discard_game_update_acquisition", "versions"],
  ["activate staged update", "versions"],
  ["prepare game data", "files"],
  ["verify", "manage"],
  ["remove", "manage"],
  ["storage location", "manage"],
] as const)("routes %s work to its owner in %s", (operation, expected) => {
  expect(detailWorkSection(operation)).toBe(expected);
});
