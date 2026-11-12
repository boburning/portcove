import { expect, it } from "vite-plus/test";
import { initializeLocalization } from "../../localization";
import {
  gameFileReasonLabel,
  gameFileRouteLabel,
  gameFileStateLabel,
  routeValues,
} from "./game-file-query-context";

it("labels every route, state and reason through the catalog in the current language", async () => {
  const localization = initializeLocalization(["en-US"]);
  const t = localization.getFixedT(null, "gameFiles");
  expect(routeValues.map((route) => gameFileRouteLabel(t, route))).toEqual([
    "Managed setup",
    "Existing installation setup",
    "Managed launch",
    "Existing installation launch",
  ]);
  expect(gameFileStateLabel(t, "files_missing")).toBe("Files missing");
  expect(gameFileReasonLabel(t, "release_not_bound")).toBe(
    "We haven’t confirmed whether this file-check result applies to the selected version.",
  );
  expect(t("summary.catalogScope", { count: 1 })).toBe("Catalog (1 port)");
  expect(t("summary.catalogScope", { count: 3 })).toBe("Catalog (3 ports)");
  try {
    await localization.changeLanguage("ar-XB");
    const arabic = localization.getFixedT(null, "gameFiles");
    expect(gameFileStateLabel(arabic, "files_missing")).toBe("الملفات مفقودة");
    expect(arabic("summary.catalogScope", { count: 2 })).toBe("الكتالوج (منفذان)");
  } finally {
    await localization.changeLanguage("en");
  }
});
