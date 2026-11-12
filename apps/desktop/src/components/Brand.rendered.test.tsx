import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { BrandMascot, BrandWordmark } from "./Brand";

it("translates the mascot description and keeps the product name literal", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  expect(renderToStaticMarkup(<BrandMascot />)).toContain('alt="Portcove crab mascot"');
  try {
    await localization.changeLanguage("ar-XB");
    expect(renderToStaticMarkup(<BrandMascot />)).toContain('alt="تميمة Portcove على شكل سلطعون"');
    expect(renderToStaticMarkup(<BrandMascot decorative />)).toContain('alt=""');
    expect(renderToStaticMarkup(<BrandWordmark />)).toContain('alt="Portcove"');
  } finally {
    await localization.changeLanguage("en");
  }
});
