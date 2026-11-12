import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { GameFileFilterContext } from "../features/browsing/game-file-query-context";
import { GameFileFilterObservation } from "./GameFileFilterObservation";

const context = {
  byPort: new Map([
    [
      "p",
      {
        port_id: "p",
        state: "files_available",
        reason: "complete_compatible_observation",
        route: "managed_install",
        platform: "windows-x86-64",
        channel: "stable",
        identity: { game_id: "g{{x}}", variant_id: "v", representation_id: "r" },
      },
    ],
  ]),
} as unknown as GameFileFilterContext;

it("translates the observation chrome and keeps the identity triple verbatim and isolated", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  expect(
    renderToStaticMarkup(<GameFileFilterObservation portId="p" context={context} />),
  ).toContain('Complete set: <bdi dir="ltr">g{{x}} / v / r</bdi>');
  try {
    await localization.changeLanguage("ar-XB");
    const markup = renderToStaticMarkup(<GameFileFilterObservation portId="p" context={context} />);
    expect(markup).toContain('aria-label="نتائج تصفية ملفات اللعبة"');
    expect(markup).toContain('مجموعة كاملة: <bdi dir="ltr">g{{x}} / v / r</bdi>');
  } finally {
    await localization.changeLanguage("en");
  }
});
