import { describe, expect, it } from "vite-plus/test";
import {
  assertCatalog,
  initializeLocalization,
  localeDirection,
  localeOptions,
  resolveLocale,
} from "./localization";
describe("localization foundation", () => {
  it("resolves only approved exact or English-family locales", () => {
    expect(resolveLocale("ar-XB", ["en-US"])).toBe("ar-XB");
    expect(resolveLocale("en-GB", ["ar-XB"])).toBe("en");
    expect(resolveLocale(null, ["fr-FR", "en-US"])).toBe("en");
    expect(resolveLocale(null, ["ar-EG"])).toBe("en");
    expect(resolveLocale(null, ["ar-XB"])).toBe("en");
    expect(resolveLocale("not_a_locale", ["ar-XB"])).toBe("en");
    expect(localeDirection("ar-XB")).toBe("rtl");
    expect(localeOptions.map(({ value }) => value)).toEqual(["system", "en"]);
  });

  it("rejects malformed and empty offline catalogs and never exposes a raw missing key", () => {
    expect(() => assertCatalog({ language: { title: "" } })).toThrow(/Empty localization/);
    expect(() => assertCatalog({ language: null })).toThrow(/Invalid localization/);
    const instance = initializeLocalization(["en-US"]);
    expect(instance.t("language.sample", { count: 2 })).toBe("2 localized messages are ready.");
    const runtimeTranslate = instance.t as unknown as (key: string) => string;
    for (const key of [
      "unknown.key",
      "language.constructor",
      "language.toString",
      "language.__proto__.constructor",
    ]) {
      expect(runtimeTranslate(key)).toBe("Translation unavailable");
    }
  });
});
